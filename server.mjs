// Plugin Seedbox — partie serveur.
// Pas de node_modules ici : tout vient de ctx (auth, settings, lib.tr4kDownload, h3…).
// Les clients torrent sont derrière un CONTRAT commun (voir providers/index.mjs) :
// qBittorrent, Hydra… Les réglages sont une LISTE de configs nommées (multi-seedbox),
// stockées chiffrées par l'hôte via ctx.settings/saveSettings.

import { randomUUID } from 'node:crypto'
import { providers, getProvider, providersMeta } from './providers/index.mjs'

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

const saveStore = (ctx, store) => ctx.saveSettings({ configs: store.configs, defaultConfig: store.defaultConfig })

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
