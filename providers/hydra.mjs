// Provider Hydra (https://github.com/Kheopsian/Hydra) via son SHIM qBittorrent v2.
// Le shim est sans état : le login accepte n'importe quels identifiants et la
// plupart des routes marchent sans cookie — donc pas de session à gérer ici.
// Différences avec un vrai qBittorrent :
//   - /app/version et /transfer/info ne sont pas garantis (test et débits adaptés) ;
//   - le routage race/hoard se fait par la CATÉGORIE (mode défini côté Hydra) ;
//   - cross-seed : `skip_checking=true` recommandé par la doc Hydra pour seeder des
//     fichiers déjà présents (savepath = dossier EXACT du contenu).

const { torrentForm, parseAddResult, netErr } = await import(`./multipart.mjs${new URL(import.meta.url).search}`)

function baseOf(cfg, io) {
  const url = (cfg.url || '').trim().replace(/\/+$/, '')
  if (!url) throw io.createError({ statusCode: 400, statusMessage: 'URL de Hydra manquante' })
  if (!/^https?:\/\//.test(url)) throw io.createError({ statusCode: 400, statusMessage: 'URL de Hydra invalide (http(s)://…)' })
  return url
}

async function shim(cfg, io, path, init = {}) {
  const base = baseOf(cfg, io)
  let res
  try {
    res = await fetch(`${base}/api/v2${path}`, { ...init, signal: AbortSignal.timeout(15000) })
  } catch (e) {
    throw io.createError({ statusCode: 502, statusMessage: `Hydra injoignable : ${netErr(e)}` })
  }
  if (!res.ok) throw io.createError({ statusCode: 502, statusMessage: `Hydra a répondu ${res.status} sur ${path}` })
  return res
}

const normalize = (t) => ({
  hash: (t.hash || t.info_hash || '').toLowerCase(),
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
  id: 'hydra',
  label: 'Hydra',
  fields: [
    { key: 'url', label: 'URL de Hydra', type: 'text', placeholder: 'http://ma-seedbox:8080', required: true,
      help: 'Adresse du shim qBittorrent de Hydra, accessible depuis ce serveur (pas depuis ton navigateur).' },
    { key: 'category', label: 'Catégorie par défaut', type: 'text', default: 'tr4k',
      help: 'La catégorie détermine le moteur (race/hoard) selon sa config côté Hydra ; inconnue = race.' },
  ],

  // le shim n'a pas d'auth : on valide juste que la liste répond
  async test(cfg, io) {
    try {
      await shim(cfg, io, '/torrents/info?limit=1')
      let version = ''
      try { // /app/version n'est pas documenté sur le shim — bonus si présent
        const r = await fetch(`${baseOf(cfg, io)}/api/v2/app/version`, { signal: AbortSignal.timeout(5000) })
        if (r.ok) version = (await r.text()).trim()
      } catch {}
      return { ok: true, version: version || 'Hydra' }
    } catch (e) {
      return { ok: false, error: e?.statusMessage || e?.message || 'Erreur inconnue' }
    }
  },

  async list(cfg, io) {
    const list = await (await shim(cfg, io, '/torrents/info?limit=5000')).json()
    return (Array.isArray(list) ? list : []).map(normalize)
  },

  // le shim n'expose pas /transfer/info — la page affiche « — » à la place des débits
  async transfer() {
    return null
  },

  async add(cfg, io, { buf, filename, category, savepath, skipChecking }) {
    const fields = { category: category || '' }
    if (savepath) fields.savepath = savepath
    // cross-seed : les fichiers sont déjà là — pattern recommandé par la doc Hydra
    if (savepath || skipChecking) fields.skip_checking = 'true'
    const { body, headers } = torrentForm(fields, filename, buf)
    const base = baseOf(cfg, io)
    let res
    try {
      res = await fetch(`${base}/api/v2/torrents/add`, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) })
    } catch (e) {
      throw io.createError({ statusCode: 502, statusMessage: `Hydra injoignable : ${netErr(e)}` })
    }
    await parseAddResult(res, io, 'Hydra')
  },
}
