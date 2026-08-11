// Multipart construit à la main pour /torrents/add : le parseur de qBittorrent 5.2.x
// est strict et avale le boundary de fermeture d'undici (FormData de Node) dans la
// dernière valeur — piège mesuré dans tr4ck/server/utils/qbit.ts, ne pas régresser.
import { randomUUID } from 'node:crypto'

/** Message court d'une erreur réseau de fetch : le code utile est dans cause
 *  (voire cause.errors[] — AggregateError quand IPv4 et IPv6 échouent tous les deux). */
export const netErr = (e) => e?.cause?.code || e?.cause?.errors?.[0]?.code || e?.cause?.message || e?.name || e?.message

export function torrentForm(fields, filename, buf) {
  const boundary = `----tr4k${randomUUID().replace(/-/g, '')}`
  const parts = []
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  const safe = String(filename).replace(/"/g, '')
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="torrents"; filename="${safe}"\r\nContent-Type: application/x-bittorrent\r\n\r\n`),
    Buffer.from(buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf),
    Buffer.from('\r\n'),
    Buffer.from(`--${boundary}--\r\n`),
  )
  return { body: Buffer.concat(parts), headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` } }
}

/**
 * Interprète la réponse de /torrents/add, dont le contrat a changé selon les versions
 * (mesuré sur qBittorrent 5.2.3) :
 *   succès               200 + JSON {added_torrent_ids, success_count, …}
 *   doublon / magnet KO  409 « Conflict »
 *   .torrent invalide    415 + message
 *   (≤5.1 : 200 « Ok. » ou 200 « Fails. »)
 */
export async function parseAddResult(res, io, who = 'qBittorrent') {
  const body = (await res.text().catch(() => '')).trim()
  if (res.status === 409)
    throw io.createError({ statusCode: 409, statusMessage: `${who} a refusé le torrent (déjà présent ?)` })
  if (res.status === 415)
    throw io.createError({ statusCode: 400, statusMessage: `Fichier .torrent invalide${body ? ` — ${body.slice(0, 120)}` : ''}` })
  if (!res.ok)
    throw io.createError({ statusCode: 502, statusMessage: `${who} a répondu ${res.status} à l'ajout` })
  if (body === 'Fails.')
    throw io.createError({ statusCode: 409, statusMessage: `${who} a refusé le torrent (doublon ou fichier invalide)` })
  if (body.startsWith('{')) {
    let j = null
    try { j = JSON.parse(body) } catch {}
    if (!j) throw io.createError({ statusCode: 502, statusMessage: `Réponse inattendue de ${who} à l'ajout` })
    if ((j.failure_count ?? 0) > 0)
      throw io.createError({ statusCode: 409, statusMessage: `${who} a rejeté le torrent` })
    if ((j.success_count ?? 0) === 0 && (j.pending_count ?? 0) === 0)
      throw io.createError({ statusCode: 502, statusMessage: `${who} n'a ajouté aucun torrent` })
  }
}
