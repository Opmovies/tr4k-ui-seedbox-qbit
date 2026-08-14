// Provider qBittorrent (WebUI API v2), compatible ≤5.1 ET ≥5.2 — pièges mesurés
// dans tr4ck/server/utils/qbit.ts, ne pas régresser :
//   - login OK = 200 « Ok. » (≤5.1) ou 204 corps vide (≥5.2) ; refus = 401 ou « Fails. » ;
//   - cookie `SID` (≤5.1) ou `QBT_SID_<port>` (≥5.2) ;
//   - ne JAMAIS envoyer Origin/Referer : qBittorrent renvoie 401 dès qu'ils ne
//     correspondent pas au Host reçu, or un reverse-proxy de seedbox réécrit le Host ;
//   - login 403/404 ou accepté sans cookie = auth déléguée à un proxy → on vérifie
//     que l'API répond sans cookie.
// Sessions par (utilisateur, config) : chaque config a SA seedbox. Mutex de login
// (qBittorrent 5.x bannit l'IP après plusieurs échecs), UNE seule re-login sur 403.

import { torrentForm, parseAddResult, netErr } from './multipart.mjs'

const sessions = new Map() // cfg._key -> { cookie: 'NAME=val' | null (auth proxy), loggingIn: Promise|null }

function baseOf(cfg, io) {
  const url = (cfg.url || '').trim().replace(/\/+$/, '')
  if (!url) throw io.createError({ statusCode: 400, statusMessage: 'URL du WebUI manquante' })
  if (!/^https?:\/\//.test(url)) throw io.createError({ statusCode: 400, statusMessage: 'URL du WebUI invalide (http(s)://…)' })
  return url
}

async function rawFetch(io, url, init = {}, timeout = 15000) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
  } catch (e) {
    throw io.createError({ statusCode: 502, statusMessage: `Seedbox injoignable : ${netErr(e)}` })
  }
}

/** L'API répond-elle avec (ou sans) cookie ? */
async function probe(io, base, cookie) {
  try {
    const res = await rawFetch(io, `${base}/api/v2/app/webapiVersion`, { headers: cookie ? { Cookie: cookie } : {} }, 8000)
    return res.ok && /^\d+\.\d+/.test((await res.text()).trim())
  } catch { return false }
}

/** Retourne le cookie de session à rejouer, ou null si l'auth est assurée en amont (proxy). */
async function login(cfg, io, base) {
  const res = await rawFetch(io, `${base}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: cfg.username || '', password: cfg.password || '' }),
  }, 8000)

  // proxy avec auth HTTP Basic devant la WebUI : cas seedbox courant, message explicite
  if (res.status === 401 && (res.headers.get('www-authenticate') || '').toLowerCase().includes('basic'))
    throw io.createError({ statusCode: 502, statusMessage: 'WebUI protégée par une authentification HTTP (Basic) côté proxy — non gérée par ce plugin' })

  if (res.ok) {
    const text = (await res.text().catch(() => '')).trim()
    if (text === 'Fails.') throw io.createError({ statusCode: 502, statusMessage: 'qBittorrent : identifiants de la WebUI refusés' })
    const m = (res.headers.get('set-cookie') || '').match(/(SID|QBT_SID_\d+)=([^;,\s]+)/)
    if (m) return `${m[1]}=${m[2]}`
    // login accepté sans cookie → auth gérée ailleurs (proxy, bypass localhost)
    if (await probe(io, base, null)) return null
    throw io.createError({ statusCode: 502, statusMessage: 'qBittorrent n’a pas renvoyé de cookie de session' })
  }
  // endpoint de login désactivé (auth déléguée au proxy) → l'API répond-elle sans cookie ?
  if ((res.status === 403 || res.status === 404) && (await probe(io, base, null))) return null
  if (res.status === 401)
    throw io.createError({ statusCode: 502, statusMessage: 'qBittorrent a refusé la connexion (identifiants invalides, IP temporairement bannie, ou validation du header Host)' })
  throw io.createError({ statusCode: 502, statusMessage: `Login qBittorrent → HTTP ${res.status}` })
}

async function ensureCookie(cfg, io, base, force = false) {
  let s = sessions.get(cfg._key)
  if (!s) sessions.set(cfg._key, (s = { cookie: undefined, loggingIn: null }))
  if (force) s.cookie = undefined
  if (s.cookie !== undefined) return s.cookie
  if (!s.loggingIn) s.loggingIn = login(cfg, io, base).finally(() => { s.loggingIn = null })
  s.cookie = await s.loggingIn
  return s.cookie
}

async function qbit(cfg, io, path, init = {}) {
  const base = baseOf(cfg, io)
  let cookie = await ensureCookie(cfg, io, base)
  const doFetch = () => rawFetch(io, `${base}/api/v2${path}`, {
    ...init,
    headers: { ...(init.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
  })
  let res = await doFetch()
  if (res.status === 403) { // session expirée → une seule re-login, jamais en boucle
    cookie = await ensureCookie(cfg, io, base, true)
    res = await doFetch()
  }
  return res
}

async function qbitOk(cfg, io, path, init = {}) {
  const res = await qbit(cfg, io, path, init)
  if (!res.ok) throw io.createError({ statusCode: 502, statusMessage: `qBittorrent a répondu ${res.status} sur ${path}` })
  return res
}

const normalize = (t) => ({
  hash: (t.hash || '').toLowerCase(),
  name: t.name || '',
  size: t.total_size || t.size || 0,
  progress: t.progress ?? 0,
  tracker: t.tracker || '',
  save_path: t.save_path || '',
  state: t.state || '',
  ratio: t.ratio ?? 0,
  dlspeed: t.dlspeed ?? 0,
  upspeed: t.upspeed ?? 0,
  added_on: t.added_on ?? 0,
})

export default {
  id: 'qbittorrent',
  label: 'qBittorrent',
  fields: [
    { key: 'url', label: 'URL du WebUI qBittorrent', type: 'text', placeholder: 'http://ma-seedbox:8080', required: true,
      help: 'Adresse du WebUI, accessible depuis ce serveur (pas depuis ton navigateur).' },
    { key: 'username', label: 'Utilisateur', type: 'text' },
    { key: 'password', label: 'Mot de passe', type: 'password', secret: true },
    { key: 'category', label: 'Catégorie par défaut', type: 'text', default: 'tr4k',
      help: 'Catégorie qBittorrent appliquée aux torrents envoyés (vide = aucune).' },
  ],

  // test EXPLICITE : re-login forcé (vérifie les identifiants, pas une session en cache)
  async test(cfg, io) {
    try {
      const base = baseOf(cfg, io)
      const cookie = await login(cfg, io, base)
      const s = sessions.get(cfg._key) || { cookie: undefined, loggingIn: null }
      s.cookie = cookie // profite du login frais pour les appels suivants
      sessions.set(cfg._key, s)
      const vRes = await rawFetch(io, `${base}/api/v2/app/version`, { headers: cookie ? { Cookie: cookie } : {} }, 8000)
      const version = vRes.ok ? (await vRes.text()).trim() : ''
      return { ok: true, version }
    } catch (e) {
      return { ok: false, error: e?.statusMessage || e?.message || 'Erreur inconnue' }
    }
  },

  async list(cfg, io) {
    const list = await (await qbitOk(cfg, io, '/torrents/info?limit=5000')).json()
    return list.map(normalize)
  },

  async transfer(cfg, io) {
    const info = await (await qbitOk(cfg, io, '/transfer/info')).json()
    return { dl: info.dl_info_speed ?? 0, up: info.up_info_speed ?? 0 }
  },

  // .torrent d'un torrent présent (pour l'upload vers TR4KER) — qBittorrent ≥ 4.5
  async export(cfg, io, hash) {
    const res = await qbit(cfg, io, `/torrents/export?hash=${encodeURIComponent(hash)}`)
    if (res.status === 404) throw io.createError({ statusCode: 502, statusMessage: 'torrents/export indisponible — qBittorrent ≥ 4.5 requis' })
    if (!res.ok) throw io.createError({ statusCode: 502, statusMessage: `qBittorrent a répondu ${res.status} sur /torrents/export` })
    return new Uint8Array(await res.arrayBuffer())
  },

  async add(cfg, io, { buf, filename, category, savepath, skipChecking }) {
    const fields = { category: category || '' }
    if (savepath) {
      fields.savepath = savepath
      fields.autoTMM = 'false' // sinon qbit ignorerait savepath
    }
    if (skipChecking) fields.skip_checking = 'true'
    const { body, headers } = torrentForm(fields, filename, buf)
    const res = await qbit(cfg, io, '/torrents/add', { method: 'POST', headers, body })
    await parseAddResult(res, io, 'qBittorrent')
  },
}
