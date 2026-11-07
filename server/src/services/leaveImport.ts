import type { Rows } from '../lib/sheet.js'

// Opening balances from the finance spreadsheet (TIME-TRACKING-APP.md §7.3).
// Upload the sheet, say which columns hold the name / email and each balance, match
// every row to a person, preview, then post one adjustment per person per leave type
// dated the switchover day. Pure functions here; the database side is in leave.ts.

export interface ImportMapping {
  /** Row number (0-based) that holds the column headings. Data starts on the row after. */
  headerRow: number
  nameCol: number | null
  emailCol: number | null
  /** Which column holds which leave type's balance, in hours. */
  columns: { col: number; leaveTypeId: string }[]
}

export interface ImportPerson {
  id: string
  name: string
  email: string
  initials: string
  active: boolean
}

export interface ImportType {
  id: string
  key: string
  name: string
}

export interface ImportRow {
  /** Row number in the sheet as people count it (1 = first row). */
  sheetRow: number
  name: string
  email: string
  personId: string | null
  personName: string | null
  match: 'email' | 'name' | 'chosen' | 'none' | 'ambiguous'
  balances: { leaveTypeId: string; hours: number | null; raw: string }[]
  problems: string[]
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** A balance cell as hours: "12.5", "12.5 hrs", "1,024.0", "(4)" for -4. Blank = null. */
export function parseHours(raw: string): number | null | 'bad' {
  let s = raw.trim().toLowerCase().replace(/,/g, '').replace(/\s*(hours|hrs|hr|h)\.?$/, '')
  if (!s || s === '-') return null
  let neg = false
  if (/^\(.*\)$/.test(s)) {
    neg = true
    s = s.slice(1, -1)
  }
  const n = Number(s)
  if (!Number.isFinite(n)) return 'bad'
  return Math.round((neg ? -n : n) * 100) / 100
}

/** First guess at the columns, from the headings. The person checks it on the preview. */
export function guessMapping(rows: Rows, types: ImportType[]): ImportMapping {
  let headerRow = 0
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const cells = rows[i].map(norm)
    if (cells.some((c) => /\b(name|employee|email)\b/.test(c)) && cells.filter(Boolean).length >= 2) {
      headerRow = i
      break
    }
  }
  const head = (rows[headerRow] ?? []).map(norm)
  const find = (re: RegExp, skip: number[] = []) => {
    const i = head.findIndex((c, idx) => re.test(c) && !skip.includes(idx))
    return i < 0 ? null : i
  }
  const emailCol = find(/\be ?mail\b/)
  const nameCol = find(/\b(name|employee)\b/, emailCol === null ? [] : [emailCol])
  const used = [emailCol, nameCol].filter((x): x is number => x !== null)
  const columns: ImportMapping['columns'] = []
  for (const t of types) {
    const words = t.key === 'sick' ? /\bsick\b/ : t.key === 'vacation' ? /\b(vac|vacation|annual)\b/ : t.key === 'pto' ? /\b(pto|paid time off)\b/ : null
    if (!words) continue
    // Prefer a column that says balance / available / remaining over "used" or "earned".
    const candidates = head.map((c, i) => ({ c, i })).filter(({ c, i }) => words.test(c) && !used.includes(i))
    const best = candidates.find(({ c }) => /\b(bal|balance|avail|available|remaining|left)\b/.test(c)) ?? candidates.find(({ c }) => !/\b(used|taken|earned|accrued)\b/.test(c)) ?? candidates[0]
    if (best) {
      columns.push({ col: best.i, leaveTypeId: t.id })
      used.push(best.i)
    }
  }
  return { headerRow, nameCol, emailCol, columns }
}

/** Every data row, matched to a person: by email first, then by full name. */
export function buildRows(rows: Rows, mapping: ImportMapping, people: ImportPerson[], chosen: Record<number, string> = {}): ImportRow[] {
  const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p]))
  const byName = new Map<string, ImportPerson[]>()
  for (const p of people) {
    const keys = new Set([norm(p.name)])
    // "Last, First" in the sheet against "First Last" here.
    const parts = norm(p.name).split(' ')
    if (parts.length >= 2) keys.add(`${parts[parts.length - 1]} ${parts.slice(0, -1).join(' ')}`)
    for (const k of keys) byName.set(k, [...(byName.get(k) ?? []), p])
  }
  const byId = new Map(people.map((p) => [p.id, p]))

  const out: ImportRow[] = []
  for (let i = mapping.headerRow + 1; i < rows.length; i++) {
    const r = rows[i] ?? []
    const cell = (c: number | null) => (c === null ? '' : (r[c] ?? '').trim())
    const name = cell(mapping.nameCol)
    const email = cell(mapping.emailCol).toLowerCase()
    const balances = mapping.columns.map(({ col, leaveTypeId }) => {
      const raw = cell(col)
      const h = parseHours(raw)
      return { leaveTypeId, hours: h === 'bad' ? null : h, raw, bad: h === 'bad' }
    })
    if (!name && !email && balances.every((b) => b.raw === '')) continue // blank line
    // A totals line at the bottom is not a person.
    if (!email && /^(total|totals|grand total|sum)\b/i.test(name)) continue

    const problems: string[] = []
    for (const b of balances) if (b.bad) problems.push(`"${b.raw}" is not a number of hours.`)

    let person: ImportPerson | undefined
    let match: ImportRow['match'] = 'none'
    if (chosen[i + 1] && byId.has(chosen[i + 1])) {
      person = byId.get(chosen[i + 1])
      match = 'chosen'
    } else if (email && byEmail.has(email)) {
      person = byEmail.get(email)
      match = 'email'
    } else if (name) {
      const hits = byName.get(norm(name)) ?? []
      if (hits.length === 1) {
        person = hits[0]
        match = 'name'
      } else if (hits.length > 1) match = 'ambiguous'
    }
    if (match === 'none') problems.push('No one in Logbook matches this row. Pick the person, or leave it out.')
    if (match === 'ambiguous') problems.push('More than one person has this name. Pick the right one.')
    out.push({
      sheetRow: i + 1,
      name,
      email,
      personId: person?.id ?? null,
      personName: person?.name ?? null,
      match,
      balances: balances.map(({ leaveTypeId, hours, raw }) => ({ leaveTypeId, hours, raw })),
      problems,
    })
  }
  // The same person twice would post two opening balances.
  const seen = new Map<string, number>()
  for (const row of out) {
    if (!row.personId) continue
    const first = seen.get(row.personId)
    if (first !== undefined) row.problems.push(`${row.personName} is also on row ${first}.`)
    else seen.set(row.personId, row.sheetRow)
  }
  return out
}

export function checkMapping(m: ImportMapping, width: number, typeIds: Set<string>): string | null {
  const okCol = (c: number | null) => c === null || (Number.isInteger(c) && c >= 0 && c < Math.max(width, 1))
  if (!Number.isInteger(m.headerRow) || m.headerRow < 0) return 'Pick the row that holds the headings.'
  if (m.nameCol === null && m.emailCol === null) return 'Pick the column with the name or the email.'
  if (!okCol(m.nameCol) || !okCol(m.emailCol)) return 'That column is not in the sheet.'
  if (!m.columns.length) return 'Pick at least one balance column.'
  const types = new Set<string>()
  for (const c of m.columns) {
    if (!okCol(c.col)) return 'That column is not in the sheet.'
    if (!typeIds.has(c.leaveTypeId)) return 'Unknown leave type.'
    if (types.has(c.leaveTypeId)) return 'Each leave type can come from one column only.'
    types.add(c.leaveTypeId)
  }
  return null
}
