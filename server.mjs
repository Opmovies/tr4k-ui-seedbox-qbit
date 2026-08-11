// Plugin Seedbox qBittorrent — partie serveur (WebUI API v2).
// Pas de node_modules ici : tout vient de ctx (auth, settings, lib.tr4kDownload, h3…).
// Sessions qbit par utilisateur (chaque user peut avoir SA seedbox), mutex de login
// (qBittorrent 5.x bannit l'IP après plusieurs échecs), UNE seule re-login sur 403.

const sessions = new Map() // userKey -> { sid, loggingIn: Promise|null }

function cfgBase(ctx) {
  const url = (ctx.settings.url || '').trim().replace(/\/+$/, '')
  if (!url) throw ctx.h3.createError({ statusCode: 400, statusMessage: 'Seedbox non configurée (URL du WebUI manquante)' })
  if (!/^https?:\/\//.test(url)) throw ctx.h3.createError({ statusCode: 400, statusMessage: 'URL du WebUI invalide (http(s)://…)' })
  return url
}

async function login(ctx, base) {
  let res
  try {
    res = await fetch(`${base}/api/v2/auth/login`, {
      method: 'POST',
      // Referer/Origin exigés par certaines versions de qBittorrent (protection CSRF)
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: base, Origin: base },
      body: new URLSearchParams({ username: ctx.settings.username || '', password: ctx.settings.password || '' }),
      signal: AbortSignal.timeout(8000),
    })
  } catch (e) {
    throw ctx.h3.createError({ statusCode: 502, statusMessage: `Seedbox injoignable : ${e?.cause?.code || e?.name || e?.message}` })
  }
  const text = await res.text().catch(() => '')
  if (!res.ok || text.trim() !== 'Ok.')
    throw ctx.h3.createError({ statusCode: 502, statusMessage: `Login qBittorrent refusé (${res.status}${text ? ' — ' + text.trim().slice(0, 60) : ''})` })
  const sid = (res.headers.get('set-cookie') || '').match(/SID=([^;]+)/)?.[1]
  if (!sid) throw ctx.h3.createError({ statusCode: 502, statusMessage: 'qBittorrent n’a pas renvoyé de cookie SID' })
  return sid
}

async function ensureSid(ctx, base, force = false) {
  let s = sessions.get(ctx.userKey)
  if (!s) sessions.set(ctx.userKey, (s = { sid: null, loggingIn: null }))
  if (force) s.sid = null
  if (s.sid) return s.sid
  if (!s.loggingIn) s.loggingIn = login(ctx, base).finally(() => { s.loggingIn = null })
  s.sid = await s.loggingIn
  return s.sid
}

async function qbit(ctx, path, init = {}) {
  const base = cfgBase(ctx)
  let sid = await ensureSid(ctx, base)
  const doFetch = async () => {
    try {
      return await fetch(`${base}/api/v2${path}`, {
        ...init,
        headers: { ...(init.headers || {}), Cookie: `SID=${sid}`, Referer: base },
        signal: AbortSignal.timeout(15000),
      })
    } catch (e) {
      throw ctx.h3.createError({ statusCode: 502, statusMessage: `Seedbox injoignable : ${e?.cause?.code || e?.name || e?.message}` })
    }
  }
  let res = await doFetch()
  if (res.status === 403) { // SID expiré → une seule re-login, jamais en boucle
    sid = await ensureSid(ctx, base, true)
    res = await doFetch()
  }
  if (!res.ok) throw ctx.h3.createError({ statusCode: 502, statusMessage: `qBittorrent a répondu ${res.status} sur ${path}` })
  return res
}

// index condensé de la seedbox pour le matching côté client — caché 30 s par utilisateur
const mapCache = new Map() // userKey -> { at, data }

export const routes = {
  // liste minimale {hash, name, size, tracker, progress} pour taguer les releases côté client
  'GET /map': async (event, ctx) => {
    const hit = mapCache.get(ctx.userKey)
    if (hit && Date.now() - hit.at < 30_000) return hit.data
    const list = await (await qbit(ctx, '/torrents/info?limit=5000')).json()
    const data = list.map((t) => ({
      hash: (t.hash || '').toLowerCase(),
      name: t.name || '',
      size: t.total_size || t.size || 0,
      tracker: t.tracker || '',
      progress: t.progress ?? 0,
    }))
    mapCache.set(ctx.userKey, { at: Date.now(), data })
    return data
  },

  // cross-seed : la même release existe sur la seedbox via un AUTRE tracker →
  // on ajoute le .torrent TR4KER dans le dossier du torrent existant ; qBittorrent
  // vérifie les fichiers déjà présents à l'ajout puis seed s'ils correspondent
  'POST /cross-seed': async (event, ctx) => {
    const slug = String(ctx.body?.slug || '').trim()
    const target = String(ctx.body?.target_hash || '').trim().toLowerCase()
    if (!/^[a-z0-9-]+$/.test(slug) || !/^[a-f0-9]{40}$/.test(target))
      throw ctx.h3.createError({ statusCode: 400, statusMessage: 'slug et target_hash requis' })

    const infos = await (await qbit(ctx, `/torrents/info?hashes=${target}`)).json()
    const existing = infos?.[0]
    if (!existing?.save_path) throw ctx.h3.createError({ statusCode: 404, statusMessage: 'Torrent cible introuvable sur la seedbox' })

    const tor = await ctx.lib.tr4kDownload(slug, ctx.auth)
    if (!tor.ok) throw ctx.h3.createError({ statusCode: 502, statusMessage: `Téléchargement du .torrent refusé (${tor.status})` })
    const fd = new FormData()
    fd.append('torrents', new Blob([await tor.arrayBuffer()], { type: 'application/x-bittorrent' }), `${slug}.torrent`)
    fd.append('savepath', existing.save_path)
    fd.append('autoTMM', 'false') // sinon qbit ignorerait savepath
    if (ctx.settings.category) fd.append('category', ctx.settings.category)

    const res = await qbit(ctx, '/torrents/add', { method: 'POST', body: fd })
    const txt = (await res.text().catch(() => '')).trim()
    if (txt === 'Fails.') throw ctx.h3.createError({ statusCode: 409, statusMessage: 'qBittorrent a refusé le torrent (déjà présent ?)' })
    mapCache.delete(ctx.userKey)
    ctx.log(`cross-seed ${slug} → ${existing.save_path}`)
    return { ok: true, slug, savepath: existing.save_path }
  },

  // test de connexion EXPLICITE : re-login forcé (vérifie les identifiants, pas un SID en cache)
  // puis lecture de la version — renvoie toujours 200 avec {ok, …} pour un affichage inline propre
  'GET /test': async (event, ctx) => {
    try {
      const base = cfgBase(ctx)
      const sid = await login(ctx, base)
      const s = sessions.get(ctx.userKey) || { sid: null, loggingIn: null }
      s.sid = sid // profite du login frais pour les appels suivants
      sessions.set(ctx.userKey, s)
      const vRes = await fetch(`${base}/api/v2/app/version`, {
        headers: { Cookie: `SID=${sid}`, Referer: base }, signal: AbortSignal.timeout(8000),
      })
      const version = vRes.ok ? (await vRes.text()).trim() : ''
      const info = await (await qbit(ctx, '/transfer/info')).json()
      return { ok: true, version, dl: info.dl_info_speed, up: info.up_info_speed }
    } catch (e) {
      return { ok: false, error: e?.statusMessage || e?.message || 'Erreur inconnue' }
    }
  },

  // état global des transferts
  'GET /status': async (event, ctx) => (await qbit(ctx, '/transfer/info')).json(),

  // liste des torrents distants, plus récents d'abord
  'GET /torrents': async (event, ctx) => (await qbit(ctx, '/torrents/info?sort=added_on&reverse=true&limit=200')).json(),

  // envoie un torrent du tracker vers la seedbox : .torrent téléchargé côté serveur
  // (avec l'auth TR4KER de l'utilisateur, rate-limité par l'hôte) puis push en multipart
  'POST /add': async (event, ctx) => {
    const slug = String(ctx.body?.slug || '').trim()
    if (!/^[a-z0-9-]+$/.test(slug)) throw ctx.h3.createError({ statusCode: 400, statusMessage: 'slug requis' })
    const tor = await ctx.lib.tr4kDownload(slug, ctx.auth)
    if (!tor.ok) throw ctx.h3.createError({ statusCode: 502, statusMessage: `Téléchargement du .torrent refusé (${tor.status})` })
    const buf = await tor.arrayBuffer()

    const fd = new FormData() // fetch pose le boundary lui-même — ne pas fixer Content-Type
    fd.append('torrents', new Blob([buf], { type: 'application/x-bittorrent' }), `${slug}.torrent`)
    if (ctx.settings.category) fd.append('category', ctx.settings.category)

    const res = await qbit(ctx, '/torrents/add', { method: 'POST', body: fd })
    const txt = (await res.text().catch(() => '')).trim()
    if (txt === 'Fails.') throw ctx.h3.createError({ statusCode: 409, statusMessage: 'qBittorrent a refusé le torrent (déjà présent ?)' })
    mapCache.delete(ctx.userKey) // le nouveau torrent doit apparaître dans le prochain /map
    ctx.log(`torrent ${slug} envoyé à la seedbox`)
    return { ok: true, slug }
  },
}
