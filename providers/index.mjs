// Registre des providers de client torrent + définition du CONTRAT commun.
//
// Un provider est un objet qui implémente :
//
//   id       : identifiant stable ('qbittorrent', 'hydra'…) — stocké dans chaque config.
//   label    : nom affiché dans l'UI.
//   fields   : schéma du formulaire de config, même format que settings.fields du
//              manifest ({ key, label, type, secret?, required?, default?, help?,
//              placeholder?, options? }). Les champs `secret` sont masqués par la
//              sentinelle '••••' côté client et résolus côté serveur.
//   test(cfg, io)      → { ok: true, version? } | { ok: false, error }
//                        Vérifie les identifiants SANS RIEN MODIFIER (ni côté client
//                        torrent, ni côté plugin) : c'est ce qui permet de tester un
//                        brouillon de config avant de l'enregistrer.
//   list(cfg, io)      → [{ hash, name, size, progress, tracker, save_path,
//                           state, ratio, dlspeed, upspeed, added_on }]
//                        Liste normalisée des torrents. `tracker` et les débits
//                        peuvent être vides si le client ne les expose pas.
//   transfer(cfg, io)  → { dl, up } en octets/s, ou null si le client ne les expose pas.
//   add(cfg, io, { buf, filename, category, savepath, skipChecking }) → void
//                        Ajoute un .torrent (Buffer/ArrayBuffer). `savepath` +
//                        `skipChecking` servent au cross-seed. Throw = échec.
//   export?(cfg, io, hash) → Uint8Array — OPTIONNEL : octets du .torrent d'un torrent
//                        présent (nécessaire à l'upload vers TR4KER ; absent = upload
//                        masqué pour les configs de ce provider).
//
//   cfg = { ...values de la config, _key } — `_key` identifie (utilisateur, config)
//         pour les sessions internes du provider (cookies, etc.).
//   io  = { createError } — fabrique d'erreurs H3 pour des messages propres côté UI.

// imports dynamiques avec le cache-buster de l'hôte propagé (cf. note de server.mjs) :
// sans lui, une mise à jour du plugin garderait les anciens providers jusqu'au restart
const V = new URL(import.meta.url).search
const qbittorrent = (await import(`./qbittorrent.mjs${V}`)).default
const hydra = (await import(`./hydra.mjs${V}`)).default

export const providers = { [qbittorrent.id]: qbittorrent, [hydra.id]: hydra }

export function getProvider(id, io) {
  const p = providers[id]
  if (!p) throw io.createError({ statusCode: 400, statusMessage: `Provider inconnu : ${id}` })
  return p
}

/** Métadonnées publiques (pour le formulaire côté client). */
export function providersMeta() {
  return Object.values(providers).map((p) => ({ id: p.id, label: p.label, fields: p.fields, canExport: typeof p.export === 'function' }))
}
