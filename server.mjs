// Plugin Seedbox — partie serveur.
// Pas de node_modules ici : tout vient de ctx (auth, settings, lib.tr4kDownload, h3…).
// Les clients torrent sont derrière un CONTRAT commun (voir providers/index.mjs) :
// qBittorrent, Hydra… Les réglages sont une LISTE de configs nommées (multi-seedbox),
// stockées chiffrées par l'hôte via ctx.settings/saveSettings.

import { randomUUID } from 'node:crypto'

// ⚠️ Node ne ré-importe JAMAIS une URL ESM déjà vue : l'hôte cache-buste server.mjs
// (?v=rev-mtime) à chaque mise à jour du plugin, mais un import relatif « nu » garderait
// les ANCIENS modules en mémoire jusqu'au redémarrage (bug réel : providers 2.1.0 sous un
// server.mjs 2.2.0 → « ne sait pas exporter »). On propage donc le cache-buster de l'hôte
// (présent dans import.meta.url) à tous les imports internes.
const V = new URL(import.meta.url).search
const { providers, getProvider, providersMeta } = await import(`./providers/index.mjs${V}`)
const { rebuildTorrent } = await import(`./bencode.mjs${V}`)

const SENTINEL = '••••' // même sentinelle que l'hôte : reçue = « valeur inchangée »

const io = (ctx) => ({ createError: ctx.h3.createError })

// ================= store des configs (migration v1 → v2 incluse) =================

function getStore(ctx) {
  const s = ctx.settings || {}
  if (Array.isArray(s.configs)) return { configs: s.configs, defaultConfig: s.defaultConfig || s.configs[0]?.id || '' }
  // v1 : réglages plats {url, username, password, category} → une config qBittorrent
  if ((s.url || '').trim()) {
    const c = { id: 'c' + randomUUID().slice(0, 8), name: 'Ma seedbox', provider: 'qbittorrent',
      values: { url: s.url, username: s.username || '', password: s.password || '', category: s.category ?? 'tr4k' } }
    const store = { configs: [c], defaultConfig: c.id }
    ctx.saveSettings(store)
    ctx.log('réglages v1 migrés vers le format multi-configs')
    return store
  }
  return { configs: [], defaultConfig: '' }
}

const saveStore = (ctx, store) => {
  ctx.saveSettings({ configs: store.configs, defaultConfig: store.defaultConfig })
  scanCache.delete(ctx.userKey) // une config ajoutée/retirée change les candidats du scan
}

function maskConfig(c) {
  const p = providers[c.provider]
  const values = { ...c.values }
  for (const f of p?.fields || []) if (f.secret && values[f.key]) values[f.key] = SENTINEL
  return { ...c, values }
}

/** Remplace les sentinelles d'un brouillon par les valeurs stockées (si la config existe déjà). */
function resolveSecrets(provider, values, stored) {
  const out = { ...values }
  for (const f of provider.fields || []) {
    if (f.secret && out[f.key] === SENTINEL) out[f.key] = stored?.values?.[f.key] || ''
  }
  return out
}

function pickConfig(ctx, id) {
  const store = getStore(ctx)
  if (!store.configs.length)
    throw ctx.h3.createError({ statusCode: 400, statusMessage: 'Seedbox non configurée (aucune configuration)' })
  const c = id ? store.configs.find((x) => x.id === id) : null
  if (id && !c) throw ctx.h3.createError({ statusCode: 404, statusMessage: 'Configuration inconnue' })
  return c || store.configs.find((x) => x.id === store.defaultConfig) || store.configs[0]
}

const cfgFor = (ctx, c) => ({ ...c.values, _key: `${ctx.userKey}:${c.id}` })

// ================= cache serveur des listes (30 s par user+config) =================

const listCache = new Map() // `${userKey}:${configId}` -> { at, data }

async function cachedList(ctx, c) {
  const key = `${ctx.userKey}:${c.id}`
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < 30_000) return hit.data
  const data = await getProvider(c.provider, io(ctx)).list(cfgFor(ctx, c), io(ctx))
  listCache.set(key, { at: Date.now(), data })
  return data
}

const invalidate = (ctx, c) => listCache.delete(`${ctx.userKey}:${c.id}`)

// ================= envoi d'un .torrent TR4KER vers une config =================

async function pushTorrent(ctx, c, slug, { savepath, skipChecking } = {}) {
  const tor = await ctx.lib.tr4kDownload(slug, ctx.auth)
  if (!tor.ok) throw ctx.h3.createError({ statusCode: 502, statusMessage: `Téléchargement du .torrent refusé (${tor.status})` })
  await getProvider(c.provider, io(ctx)).add(cfgFor(ctx, c), io(ctx), {
    buf: await tor.arrayBuffer(),
    filename: `${slug}.torrent`,
    category: c.values.category || '',
    savepath,
    skipChecking,
  })
  invalidate(ctx, c)
  scanCache.delete(ctx.userKey) // l'inventaire change → le scan cross-seed est périmé
}

// ================= scan cross-seed : seedbox → tracker =================
// Compare les torrents TERMINÉS des configs (hors ceux qui annoncent déjà TR4KER)
// au catalogue du tracker via POST /api/migrations/match : matching PAR LOT, une
// ligne = un nom de release OU un info_hash (casse ignorée, séparateurs NON — on
// envoie les noms tels quels). Une requête couvre ~40 torrents, indispensable avec
// le budget 20 req/min de l'hôte. Statuts calculés ici, affichés par la page :
//   'done'   la version TR4KER du match est déjà sur la seedbox (hash présent)
//   'same'   le match a le MÊME info_hash que le candidat → rien à cross-seeder
//   'cross'  même release, taille identique à l'octet → cross-seed 1 clic
//   'near'   taille ±2 % → cross-seed possible mais re-téléchargement partiel
//   'diff'   même nom mais taille trop éloignée → probablement une autre version
//   'absent' introuvable sur le tracker (candidat à un futur upload)

const SCAN_TTL = 10 * 60_000
const SCAN_MAX = 400 // au-delà : les plus récents seulement, signalé par `truncated`
const scanCache = new Map() // userKey -> { at, data }

const isTr4kTracker = (url) => /tr4ker/i.test(url || '')

async function matchBatch(ctx, lines) {
  const out = new Map() // ligne envoyée -> torrent TR4KER | null
  for (let i = 0; i < lines.length; i += 80) {
    const res = await ctx.lib.tr4kMutate('POST', 'migrations/match', ctx.auth, { text: lines.slice(i, i + 80).join('\n') })
    for (const r of res?.results || []) out.set(r.query, r.torrent || null)
  }
  return out
}

// ================= upload assisté : torrent absent du tracker =================
// prepare : exporte le .torrent depuis le client (qBittorrent ≥ 4.5), le reconstruit
// pour TR4KER (private=1 + source=TR4KER → nouvel info_hash), preflight anti-doublon
// sur les DEUX hash (le reconstruit ET l'original — les migrations gardent le hash
// d'origine), et renvoie tout le pré-rempli (release parsée, catégories, TMDB).
// commit : POST /api/torrents multipart (mêmes champs que le flux d'import du site,
// contrat relevé dans tr4ker_upload.py), puis remet le .torrent TR4KER en seed sur
// la seedbox (savepath d'origine, le client vérifie les fichiers).

const preparedUploads = new Map() // `${userKey}:${infoHash}` -> { at, prep, configId }
const PREP_TTL = 20 * 60_000

const RX = {
  res: /\b(2160p|1080p|720p|576p|480p|4K|UHD)\b/i,
  src: /\b(UHD\.?BluRay|BluRay|BDRip|BRRip|HDLight|WEB-?DL|WEBRip|WEB|HDRip|DVDRip|DVD|HDTV|REMUX)\b/i,
  vid: /\b(x264|x265|H\.?264|H\.?265|HEVC|AV1|XviD|VP9)\b/i,
  aud: /\b(TrueHD(?:\.?Atmos)?|E-?AC-?3(?:\.?Atmos)?|DTS(?:[-.]?HD)?(?:\.?MA)?|AC-?3|EAC3|AAC|FLAC|Opus|PCM|MP3)\b/i,
  lang: /\b(MULTI|TRUEFRENCH|FRENCH|VOSTFR|SUBFRENCH|VFF|VFQ|VFI|VF|VO|ENGLISH)\b/i,
  year: /\b(19\d{2}|20\d{2})\b/,
  ep: /\bS(\d{1,2})(?:E(\d{1,3}))?\b/i,
  group: /-([A-Za-z0-9]+)$/,
}

function parseRelease(name) {
  const base = String(name || '').replace(/\.(mkv|mp4|avi|iso|epub|pdf|mobi|azw3?|cbz|cbr|mp3|flac|m4a|opus|ogg|wav)$/i, '')
  const pick = (rx) => (base.match(rx) || [''])[0]
  const ep = base.match(RX.ep)
  const d = {
    resolution: pick(RX.res), source: pick(RX.src), video: pick(RX.vid), audio: pick(RX.aud),
    lang: pick(RX.lang), year: pick(RX.year),
    season: ep ? ep[1] : '', episode: ep && ep[2] ? ep[2] : '',
    group: (base.match(RX.group) || ['', ''])[1],
  }
  // titre = tout ce qui précède le premier marqueur technique (SxxEyy / année / résolution / source)
  let cut = base
  for (const rx of [RX.ep, RX.year, RX.res, RX.src]) {
    const m = cut.match(rx)
    if (m) { cut = cut.slice(0, m.index); break }
  }
  d.title = cut.replace(/[._]/g, ' ').replace(/\s*[[(].*/, '').replace(/[ \-–·]+$/g, '').trim()
  return d
}

/** Slug de catégorie PARENTE probable (les catégories du site sont une liste plate id/slug/parent_id). */
function guessCategory(rel, cats) {
  const parents = new Set((cats || []).filter((c) => !c.parent_id).map((c) => c.slug))
  const has = (s) => parents.has(s) ? s : ''
  if (rel.season) return has('series')
  if (rel.resolution || rel.source) return has('films')
  return ''
}

const humanSize = (n) => n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' Go' : (n / 1048576).toFixed(0) + ' Mo'

/** Présentation BBCode par défaut — garantit de ne jamais uploader une description vide. */
function defaultPresentation(prep, rel) {
  const rows = [
    ['Qualité', rel.resolution], ['Source', rel.source], ['Codec', rel.video],
    ['Audio', rel.audio], ['Langue', rel.lang], ['Taille', humanSize(prep.size)],
    ['Fichiers', String(prep.files.length)],
  ].filter(([, v]) => String(v || '').trim())
  const list = rows.length ? ['[b]Fiche technique[/b]', '[list]', ...rows.map(([k, v]) => `[*][b]${k}[/b] : ${v}`), '[/list]'] : []
  return [`[center][b]${prep.name}[/b][/center]`, '', ...list].join('\n')
}

/** Announce TR4KER de l'utilisateur (embarque son passkey) — exposé par le feed /api/ygg. */
async function getAnnounce(ctx) {
  const r = await ctx.lib.tr4kGet('ygg', { per: 1 }, ctx.auth)
  const a = r?.data?.announce_url
  if (!a || !/^https?:\/\//.test(a)) throw ctx.h3.createError({ statusCode: 502, statusMessage: 'Announce TR4KER introuvable (feed ygg muet)' })
  return a
}

async function preflight(ctx, infoHash, title) {
  try {
    return await ctx.lib.tr4kMutate('POST', 'torrents/preflight', ctx.auth, { info_hash: infoHash, title, nfo: '' })
  } catch (e) {
    return { error: e?.statusMessage || e?.message || 'preflight en échec' }
  }
}

export const routes = {
  // ---- providers & configs ----

  'GET /providers': async () => providersMeta(),

  'GET /configs': async (event, ctx) => {
    const store = getStore(ctx)
    return { configs: store.configs.map(maskConfig), defaultConfig: store.defaultConfig }
  },

  // crée ou met à jour une config ; les champs secret à '••••' gardent la valeur stockée
  'POST /configs/save': async (event, ctx) => {
    const c = ctx.body?.config || {}
    const name = String(c.name || '').trim()
    if (!name) throw ctx.h3.createError({ statusCode: 400, statusMessage: 'Nom de configuration requis' })
    const provider = getProvider(String(c.provider || ''), io(ctx))
    const store = getStore(ctx)
    const existing = c.id ? store.configs.find((x) => x.id === c.id) : null
    if (c.id && !existing) throw ctx.h3.createError({ statusCode: 404, statusMessage: 'Configuration inconnue' })
    const saved = {
      id: existing?.id || 'c' + randomUUID().slice(0, 8),
      name,
      provider: provider.id,
      values: resolveSecrets(provider, c.values || {}, existing),
    }
    if (existing) store.configs = store.configs.map((x) => (x.id === saved.id ? saved : x))
    else store.configs = [...store.configs, saved]
    if (!store.defaultConfig) store.defaultConfig = saved.id
    saveStore(ctx, store)
    invalidate(ctx, saved)
    ctx.log(`config « ${name} » (${provider.id}) enregistrée`)
    return { ok: true, config: maskConfig(saved), defaultConfig: store.defaultConfig }
  },

  'POST /configs/delete': async (event, ctx) => {
    const id = String(ctx.body?.id || '')
    const store = getStore(ctx)
    if (!store.configs.some((x) => x.id === id)) throw ctx.h3.createError({ statusCode: 404, statusMessage: 'Configuration inconnue' })
    store.configs = store.configs.filter((x) => x.id !== id)
    if (store.defaultConfig === id) store.defaultConfig = store.configs[0]?.id || ''
    saveStore(ctx, store)
    listCache.delete(`${ctx.userKey}:${id}`)
    return { ok: true, defaultConfig: store.defaultConfig }
  },

  'POST /configs/default': async (event, ctx) => {
    const id = String(ctx.body?.id || '')
    const store = getStore(ctx)
    if (!store.configs.some((x) => x.id === id)) throw ctx.h3.createError({ statusCode: 404, statusMessage: 'Configuration inconnue' })
    store.defaultConfig = id
    saveStore(ctx, store)
    return { ok: true, defaultConfig: id }
  },

  // teste un BROUILLON de config sans rien enregistrer — répond toujours 200 {ok, …}
  // pour un affichage inline propre. Les '••••' sont résolus depuis la config stockée.
  'POST /configs/test': async (event, ctx) => {
    try {
      const c = ctx.body?.config || {}
      const provider = getProvider(String(c.provider || ''), io(ctx))
      const store = getStore(ctx)
      const existing = c.id ? store.configs.find((x) => x.id === c.id) : null
      const values = resolveSecrets(provider, c.values || {}, existing)
      return await provider.test({ ...values, _key: `${ctx.userKey}:${existing?.id || 'draft'}` }, io(ctx))
    } catch (e) {
      return { ok: false, error: e?.statusMessage || e?.message || 'Erreur inconnue' }
    }
  },

  // ---- torrents ----

  // index condensé AGRÉGÉ sur toutes les configs, pour le matching côté client.
  // Une config injoignable est ignorée (les autres continuent de répondre) ;
  // si TOUTES échouent, on relaie la première erreur.
  'GET /map': async (event, ctx) => {
    const store = getStore(ctx)
    if (!store.configs.length)
      throw ctx.h3.createError({ statusCode: 400, statusMessage: 'Seedbox non configurée (aucune configuration)' })
    const out = []
    let firstErr = null
    let okCount = 0
    for (const c of store.configs) {
      try {
        const list = await cachedList(ctx, c)
        okCount++
        for (const t of list) out.push({ hash: t.hash, name: t.name, size: t.size, tracker: t.tracker, progress: t.progress, config: c.id })
      } catch (e) {
        firstErr = firstErr || e
        ctx.log(`map : config « ${c.name} » injoignable (${e?.statusMessage || e?.message})`)
      }
    }
    if (!okCount && firstErr) throw firstErr
    return out
  },

  // état + liste d'une config (?config=<id>, défaut = config par défaut)
  'GET /torrents': async (event, ctx) => {
    const c = pickConfig(ctx, String(ctx.query?.config || '') || undefined)
    const provider = getProvider(c.provider, io(ctx))
    const transfer = await provider.transfer(cfgFor(ctx, c), io(ctx))
    const torrents = (await cachedList(ctx, c))
      .slice()
      .sort((a, b) => (b.added_on || 0) - (a.added_on || 0))
      .slice(0, 200)
    return { config: { id: c.id, name: c.name, provider: c.provider }, transfer, torrents }
  },

  // scan cross-seed (voir bloc de doc plus haut) — cache 10 min par user, ?refresh=1 force
  'GET /cross-scan': async (event, ctx) => {
    const store = getStore(ctx)
    if (!store.configs.length)
      throw ctx.h3.createError({ statusCode: 400, statusMessage: 'Seedbox non configurée (aucune configuration)' })
    const cached = scanCache.get(ctx.userKey)
    if (!ctx.query?.refresh && cached && Date.now() - cached.at < SCAN_TTL) return { ...cached.data, cache: true }

    // 1) inventaire agrégé — une config injoignable n'empêche pas les autres
    const entries = []
    const configsOut = []
    const allHashes = new Set()
    for (const c of store.configs) {
      try {
        const list = await cachedList(ctx, c)
        configsOut.push({ id: c.id, name: c.name, ok: true })
        for (const t of list) {
          if (t.hash) allHashes.add(t.hash)
          entries.push({ ...t, config: c.id, config_name: c.name })
        }
      } catch (e) {
        configsOut.push({ id: c.id, name: c.name, ok: false, error: e?.statusMessage || e?.message || 'injoignable' })
      }
    }
    if (!configsOut.some((x) => x.ok))
      throw ctx.h3.createError({ statusCode: 502, statusMessage: `Aucune seedbox joignable (${configsOut[0]?.error || '?'})` })

    // 2) candidats : terminés, n'annonçant pas (ou plus) TR4KER — les torrents TR4KER
    // au tracker en erreur (champ vide) passent ici puis ressortent en 'same' via le hash
    let candidates = entries.filter((t) => (t.progress ?? 0) >= 0.999 && !isTr4kTracker(t.tracker))
    candidates.sort((a, b) => (b.added_on || 0) - (a.added_on || 0))
    const truncated = candidates.length > SCAN_MAX
    if (truncated) candidates = candidates.slice(0, SCAN_MAX)

    // 3) matching par lot (nom + hash par candidat, lignes dédupliquées)
    const lines = [...new Set(candidates.flatMap((t) => [String(t.name || '').trim(), t.hash].filter(Boolean)))]
    const matches = lines.length ? await matchBatch(ctx, lines) : new Map()

    // 4) classement
    const items = candidates.map((t) => {
      const m = matches.get(String(t.name || '').trim()) || matches.get(t.hash) || null
      let status = 'absent'
      if (m) {
        if (m.info_hash === t.hash) status = 'same'
        else if (allHashes.has(m.info_hash)) status = 'done'
        else if (m.size_bytes === t.size) status = 'cross'
        else if (Math.abs((m.size_bytes || 0) - (t.size || 0)) / Math.max(m.size_bytes || 1, t.size || 1) <= 0.02) status = 'near'
        else status = 'diff'
      }
      return {
        hash: t.hash, name: t.name, size: t.size, added_on: t.added_on,
        config: t.config, config_name: t.config_name, status,
        tracker: t.tracker || '', // tracker ACTUEL du torrent (provenance), affiché par la page
        match: m ? { slug: m.slug, name: m.name, size_bytes: m.size_bytes, seeders: m.seeders } : null,
      }
    })

    const counts = {}
    for (const i of items) counts[i.status] = (counts[i.status] || 0) + 1
    const data = { scanned_at: Date.now(), configs: configsOut, truncated, counts, items }
    scanCache.set(ctx.userKey, { at: Date.now(), data })
    ctx.log(`cross-scan : ${items.length} candidat(s), ${counts.cross || 0} cross-seedable(s)`)
    return data
  },

  // ---- upload assisté (voir bloc de doc plus haut) ----

  'POST /upload/prepare': async (event, ctx) => {
    const hash = String(ctx.body?.hash || '').trim().toLowerCase()
    if (!/^[a-f0-9]{40}$/.test(hash)) throw ctx.h3.createError({ statusCode: 400, statusMessage: 'hash requis' })
    const c = pickConfig(ctx, String(ctx.body?.config || '') || undefined)
    const provider = getProvider(c.provider, io(ctx))
    if (typeof provider.export !== 'function')
      throw ctx.h3.createError({ statusCode: 400, statusMessage: `Le client « ${provider.label} » ne sait pas exporter un .torrent` })
    const t = (await cachedList(ctx, c)).find((x) => x.hash === hash)
    if (!t) throw ctx.h3.createError({ statusCode: 404, statusMessage: 'Torrent introuvable sur la seedbox' })
    if ((t.progress ?? 0) < 0.999)
      throw ctx.h3.createError({ statusCode: 400, statusMessage: 'Torrent incomplet — impossible de l’uploader' })

    const raw = await provider.export(cfgFor(ctx, c), io(ctx), hash)
    const announce = await getAnnounce(ctx)
    const prep = rebuildTorrent(raw, announce)
    prep.save_path = t.save_path || ''

    // doublon ? les DEUX hash comptent (reconstruit + original, cf. bloc de doc)
    const [preNew, preOrig] = [await preflight(ctx, prep.infoHash, prep.name), await preflight(ctx, prep.originalHash, prep.name)]
    const existing = preOrig?.hash_conflict || preNew?.hash_conflict || null

    const rel = parseRelease(prep.name)
    let cats = []
    try { cats = (await ctx.lib.tr4kGet('public/categories', {}, ctx.auth)).data || [] } catch {}
    let tmdb = []
    if (rel.title) {
      try {
        const r = await ctx.lib.tr4kGet('tmdb/suggest', { q: rel.title }, ctx.auth)
        tmdb = (r?.data?.results || []).slice(0, 5)
      } catch {}
    }

    preparedUploads.set(`${ctx.userKey}:${prep.infoHash}`, { at: Date.now(), prep, configId: c.id })
    for (const [k, v] of preparedUploads) if (Date.now() - v.at > PREP_TTL) preparedUploads.delete(k)

    return {
      info_hash: prep.infoHash, original_hash: prep.originalHash,
      name: prep.name, size: prep.size, file_count: prep.files.length,
      save_path: prep.save_path, config: c.id,
      release: rel, existing, // {slug, name…} si le FICHIER est déjà sur TR4KER
      categories: cats.map((x) => ({ id: x.id, slug: x.slug, name: x.name, parent_id: x.parent_id || null })),
      category_guess: guessCategory(rel, cats),
      tmdb, tmdb_type: rel.season ? 'tv' : 'movie',
      presentation: defaultPresentation(prep, rel),
    }
  },

  'POST /upload/commit': async (event, ctx) => {
    if (typeof ctx.lib.tr4kMultipart !== 'function')
      throw ctx.h3.createError({ statusCode: 501, statusMessage: 'Hôte trop ancien pour l’upload — mets TR4K UI à jour (≥ 1.5.6)' })
    const infoHash = String(ctx.body?.info_hash || '').trim().toLowerCase()
    const hit = preparedUploads.get(`${ctx.userKey}:${infoHash}`)
    if (!hit || Date.now() - hit.at > PREP_TTL)
      throw ctx.h3.createError({ statusCode: 410, statusMessage: 'Préparation expirée — rouvre la fenêtre d’upload' })
    const { prep, configId } = hit
    const f = ctx.body?.form || {}
    const name = String(f.name || prep.name).trim()
    const catSlug = String(f.category_slug || '').trim()
    if (!catSlug) throw ctx.h3.createError({ statusCode: 400, statusMessage: 'Catégorie requise' })

    const rel = parseRelease(prep.name)
    const pres = String(f.presentation || '').trim() || defaultPresentation(prep, rel)
    const nfo = String(f.nfo || '')
    const tags = String(f.tags || '').split(',').map((s) => s.trim()).filter(Boolean)
    const fields = {
      info_hash: prep.infoHash,
      original_hash: prep.originalHash,
      name,
      nfo,
      mediainfo: nfo, // même doublage que le flux d'import du site
      size_bytes: String(prep.size),
      file_count: String(prep.files.length),
      piece_length: String(prep.pieceLength),
      category_slug: catSlug,
      tags: JSON.stringify(tags),
      description: String(f.description || '').trim(),
      tech_info_xml: '',
      extra_info: pres,
      extra_info_format: 'bbcode',
      classic_description: pres, // c'est CE champ que le site persiste comme description
      classic_description_format: 'bbcode',
      is_anonymous: f.is_anonymous ? 'true' : 'false',
      is_exclusive: 'false',
      files: JSON.stringify(prep.files),
    }
    if (f.subcategory_slug) fields.subcategory_slug = String(f.subcategory_slug)
    if (f.tmdb_id) {
      fields.tmdb_id = String(f.tmdb_id)
      fields.tmdb_type = String(f.tmdb_type || 'movie')
    }
    if (f.poster_url) fields.poster_url = String(f.poster_url)
    if (f.year || rel.year) fields.year = String(f.year || rel.year)

    const res = await ctx.lib.tr4kMultipart('torrents', {
      fields,
      file: { field: 'torrent', name: `${prep.name}.torrent`, data: prep.bytes },
    }, ctx.auth)

    // remet la version TR4KER en seed sur les fichiers d'origine (le client vérifie)
    let seeded = false
    if (f.seed_after !== false && prep.save_path) {
      try {
        const c = pickConfig(ctx, configId)
        await getProvider(c.provider, io(ctx)).add(cfgFor(ctx, c), io(ctx), {
          buf: prep.bytes,
          filename: `${prep.name}.torrent`,
          category: c.values.category || '',
          savepath: prep.save_path,
        })
        invalidate(ctx, c)
        seeded = true
      } catch (e) {
        ctx.log(`upload ${name} : mise en seed ratée (${e?.statusMessage || e?.message})`)
      }
    }
    preparedUploads.delete(`${ctx.userKey}:${infoHash}`)
    scanCache.delete(ctx.userKey)
    ctx.log(`upload « ${name} » envoyé au tracker (cat ${catSlug}${seeded ? ', remis en seed' : ''})`)
    return { ok: true, slug: res?.slug || res?.torrent?.slug || null, seeded, response: res }
  },

  // envoie un torrent du tracker vers une config : .torrent téléchargé côté serveur
  // (avec l'auth TR4KER de l'utilisateur, rate-limité par l'hôte) puis push au provider
  'POST /add': async (event, ctx) => {
    const slug = String(ctx.body?.slug || '').trim()
    if (!/^[a-z0-9-]+$/.test(slug)) throw ctx.h3.createError({ statusCode: 400, statusMessage: 'slug requis' })
    const c = pickConfig(ctx, String(ctx.body?.config || '') || undefined)
    await pushTorrent(ctx, c, slug)
    ctx.log(`torrent ${slug} envoyé à « ${c.name} »`)
    return { ok: true, slug, config: c.id }
  },

  // cross-seed : la même release existe sur la seedbox via un AUTRE tracker →
  // on ajoute le .torrent TR4KER dans le dossier du torrent existant ; le client
  // torrent vérifie les fichiers déjà présents puis seed s'ils correspondent
  'POST /cross-seed': async (event, ctx) => {
    const slug = String(ctx.body?.slug || '').trim()
    const target = String(ctx.body?.target_hash || '').trim().toLowerCase()
    if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-f0-9]{40}$/.test(target))
      throw ctx.h3.createError({ statusCode: 400, statusMessage: 'slug et target_hash requis' })
    const c = pickConfig(ctx, String(ctx.body?.config || '') || undefined)
    const existing = (await cachedList(ctx, c)).find((t) => t.hash === target)
    if (!existing?.save_path) throw ctx.h3.createError({ statusCode: 404, statusMessage: 'Torrent cible introuvable sur la seedbox' })
    await pushTorrent(ctx, c, slug, { savepath: existing.save_path })
    ctx.log(`cross-seed ${slug} → ${existing.save_path} (« ${c.name} »)`)
    return { ok: true, slug, savepath: existing.save_path, config: c.id }
  },
}
