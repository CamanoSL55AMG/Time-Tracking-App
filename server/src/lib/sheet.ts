import { inflateRawSync } from 'node:zlib'

// Reads the first sheet of an .xlsx workbook, or a .csv file, into rows of text.
// Small on purpose (no dependency): enough for a balance sheet of names and numbers.
// Formulas come through as their last calculated value, which Excel saves.

export type Rows = string[][]

const MAX_ROWS = 5000
const MAX_COLS = 60

// ─── CSV ────────────────────────────────────────────────────────────────────

export function parseCsv(text: string): Rows {
  const rows: Rows = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        cell += '"'
        i++
      } else if (c === '"') quoted = false
      else cell += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell)
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (rows.length >= MAX_ROWS) break
    } else cell += c
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.map((r) => r.slice(0, MAX_COLS).map((v) => v.trim()))
}

// ─── XLSX (a zip of XML files) ──────────────────────────────────────────────

function unzip(buf: Buffer): Map<string, Buffer> {
  // Find the end-of-central-directory record from the back.
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not_zip')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const files = new Map<string, Buffer>()
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad_zip')
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const local = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (!/^xl\/(workbook\.xml|sharedStrings\.xml|worksheets\/[^/]+\.xml|_rels\/workbook\.xml\.rels)$/.test(name)) continue
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad_zip')
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28)
    const data = buf.subarray(start, start + compSize)
    if (method === 0) files.set(name, Buffer.from(data))
    else if (method === 8) files.set(name, inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 }))
  }
  return files
}

const decode = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&')

/** Text of every <t> inside a fragment (rich text is several runs). */
const textOf = (xml: string) => [...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('')

const colIndex = (ref: string) => {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

export function parseXlsx(buf: Buffer): Rows {
  const files = unzip(buf)
  const shared = files.get('xl/sharedStrings.xml')?.toString('utf8') ?? ''
  const strings = [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]))

  // The first sheet in workbook order (not file order).
  let sheetPath = 'xl/worksheets/sheet1.xml'
  const wb = files.get('xl/workbook.xml')?.toString('utf8') ?? ''
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? ''
  const firstRid = /<sheet\b[^>]*\br:id="([^"]+)"/.exec(wb)?.[1]
  if (firstRid) {
    const rel = new RegExp(`<Relationship\\b[^>]*\\bId="${firstRid}"[^>]*>`).exec(rels)?.[0]
    const target = rel ? /\bTarget="([^"]+)"/.exec(rel)?.[1] : undefined
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  }
  const sheet = files.get(sheetPath)?.toString('utf8')
  if (!sheet) throw new Error('no_sheet')

  const rows: Rows = []
  for (const r of sheet.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowNum = Number(/\br="(\d+)"/.exec(r[1])?.[1] ?? rows.length + 1)
    if (rowNum > MAX_ROWS) break
    const row: string[] = []
    for (const c of r[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]
      const body = c[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const idx = ref ? colIndex(ref) : row.length
      if (idx >= MAX_COLS) continue
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let value = ''
      if (type === 's') value = strings[Number(v)] ?? ''
      else if (type === 'inlineStr') value = textOf(body)
      else if (v !== undefined) value = decode(v)
      while (row.length < idx) row.push('')
      row[idx] = value.trim()
    }
    while (rows.length < rowNum - 1) rows.push([])
    rows.push(row)
  }
  return rows
}

/** A file as uploaded: .xlsx by its zip signature, anything else read as CSV text. */
export function readSheet(fileName: string, data: Buffer): Rows {
  const isZip = data.length > 4 && data.readUInt32LE(0) === 0x04034b50
  if (isZip) return parseXlsx(data)
  if (/\.xls$/i.test(fileName)) throw new Error('old_xls')
  return parseCsv(data.toString('utf8'))
}
