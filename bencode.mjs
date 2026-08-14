// Bencode minimal pour l'upload : décode/réencode un .torrent SANS toucher aux octets
// binaires (`pieces`). Représentation : byte-strings = Uint8Array, dicts = Map (clés
// décodées en latin1 — les clés bencode d'un .torrent sont ASCII), listes = Array,
// entiers = Number. Même logique que rebuild_torrent de tr4ker_upload.py.

import { createHash } from 'node:crypto'

const te = new TextEncoder()
const latin1 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return s }

export function bdecode(buf, i = 0) {
  const c = buf[i]
  if (c === 0x69) { // 'i'
    const j = buf.indexOf(0x65, i) // 'e'
    return [parseInt(latin1(buf.subarray(i + 1, j)), 10), j + 1]
  }
  if (c === 0x6c) { // 'l'
    const out = []
    i++
    while (buf[i] !== 0x65) { const [v, n] = bdecode(buf, i); out.push(v); i = n }
    return [out, i + 1]
  }
  if (c === 0x64) { // 'd'
    const out = new Map()
    i++
    while (buf[i] !== 0x65) {
      const [k, n1] = bdecode(buf, i)
      const [v, n2] = bdecode(buf, n1)
      out.set(latin1(k), v)
      i = n2
    }
    return [out, i + 1]
  }
  if (c >= 0x30 && c <= 0x39) { // chiffre → byte-string
    const j = buf.indexOf(0x3a, i) // ':'
    const len = parseInt(latin1(buf.subarray(i, j)), 10)
    return [buf.subarray(j + 1, j + 1 + len), j + 1 + len]
  }
  throw new Error(`bencode inattendu 0x${(c ?? 0).toString(16)} @ ${i}`)
}

export function bencode(v) {
  if (typeof v === 'number') return te.encode(`i${v}e`)
  if (typeof v === 'string') v = te.encode(v)
  if (v instanceof Uint8Array) {
    const head = te.encode(`${v.length}:`)
    const out = new Uint8Array(head.length + v.length)
    out.set(head); out.set(v, head.length)
    return out
  }
  if (Array.isArray(v)) return concat([te.encode('l'), ...v.map(bencode), te.encode('e')])
  if (v instanceof Map) {
    const keys = [...v.keys()].sort() // clés ASCII : tri lexicographique = tri d'octets
    return concat([te.encode('d'), ...keys.flatMap((k) => [bencode(te.encode(k)), bencode(v.get(k))]), te.encode('e')])
  }
  throw new Error(`bencode : type non géré ${typeof v}`)
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) { out.set(p, o); o += p.length }
  return out
}

/** Tranche BRUTE du dict info (info_hash d'origine, indépendant de notre encodeur). */
export function rawInfoSlice(buf) {
  if (buf[0] !== 0x64) throw new Error('pas un dict bencodé')
  let i = 1
  while (buf[i] !== 0x65) {
    const [k, n1] = bdecode(buf, i)
    const [, n2] = bdecode(buf, n1)
    if (latin1(k) === 'info') return buf.subarray(n1, n2)
    i = n2
  }
  throw new Error('clé info absente')
}

const sha1hex = (u8) => createHash('sha1').update(u8).digest('hex')
const utf8 = (u8) => new TextDecoder('utf-8', { fatal: false }).decode(u8)

/** Reconstruit un .torrent pour TR4KER (même logique que le flux d'import du site) :
 *  info inchangé + private=1 + source=<tag> → nouvel info_hash, données identiques. */
export function rebuildTorrent(raw, announce, source = 'TR4KER') {
  const [top] = bdecode(raw)
  const info = new Map(top.get('info'))
  info.set('private', 1)
  info.set('source', te.encode(source))

  const name = utf8(info.get('name'))
  const pieceLength = info.get('piece length') || 0
  const files = []
  let size = 0
  if (info.has('files')) {
    for (const f of info.get('files')) {
      const path = [name, ...f.get('path').map(utf8)].join('/')
      files.push({ path, size: f.get('length') })
      size += f.get('length')
    }
  } else {
    size = info.get('length')
    files.push({ path: name, size })
  }

  const originalHash = sha1hex(rawInfoSlice(raw))
  const infoHash = sha1hex(bencode(info))
  const bytes = bencode(new Map([
    ['announce', te.encode(announce)],
    ['announce-list', [[te.encode(announce)]]],
    ['created by', te.encode(source)],
    ['creation date', Math.floor(Date.now() / 1000)],
    ['info', info],
  ]))
  return { bytes, infoHash, originalHash, name, size, pieceLength, files }
}
