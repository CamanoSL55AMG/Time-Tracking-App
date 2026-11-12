// Grouping people by division, for the Board (Art, 2026-11-12: "I'd like to have those
// grouped so I can expand and collapse", each header "just the first name").
// Pure functions plus a small per-browser memory of what is open; no React here, so
// `npm test` can run it under plain Node.

/** The heading for people with no division set. */
export const NO_DIVISION = 'No division'

export interface DivisionGroup<T> {
  /** Lower-case, space-folded division name: the same match the server uses. '' = none. */
  key: string
  /** The name shown in the heading. */
  label: string
  rows: T[]
}

/** Trim and fold runs of spaces, like the server's normalizeDivision. */
export function cleanDivision(d: string | null | undefined): string {
  return typeof d === 'string' ? d.trim().replace(/\s+/g, ' ') : ''
}

/**
 * People by division, divisions A to Z with "No division" last. Divisions match
 * without case, so "Sound Services" and "sound services" are one group. The order of
 * people inside a group is kept as given (the board puts people on the clock first).
 */
export function groupByDivision<T extends { division?: string | null }>(rows: T[]): DivisionGroup<T>[] {
  const groups = new Map<string, DivisionGroup<T>>()
  for (const r of rows) {
    const label = cleanDivision(r.division)
    const key = label.toLowerCase()
    let g = groups.get(key)
    if (!g) {
      g = { key, label: label || NO_DIVISION, rows: [] }
      groups.set(key, g)
    }
    g.rows.push(r)
  }
  return [...groups.values()].sort((a, b) => {
    if (!a.key !== !b.key) return a.key ? -1 : 1
    return a.label.localeCompare(b.label)
  })
}

const words = (name: string) => name.trim().split(/\s+/).filter(Boolean)
const firstOf = (name: string) => words(name)[0] ?? ''
const lastInitialOf = (name: string) => {
  const w = words(name)
  return w.length > 1 ? `${w[w.length - 1][0].toUpperCase()}.` : ''
}

/**
 * The name to show on each person's header: the first name only. When two people in
 * the same list share a first name, both get their last initial ("Mike S.", "Mike T.");
 * if that still doesn't tell them apart, both show their full name.
 */
export function shortNames<T extends { id: string; name: string }>(people: T[]): Map<string, string> {
  const byFirst = new Map<string, T[]>()
  for (const p of people) {
    const f = firstOf(p.name).toLowerCase()
    byFirst.set(f, [...(byFirst.get(f) ?? []), p])
  }
  const out = new Map<string, string>()
  for (const same of byFirst.values()) {
    if (same.length === 1) {
      const p = same[0]
      out.set(p.id, firstOf(p.name) || p.name)
      continue
    }
    const withInitial = same.map((p) => `${firstOf(p.name)} ${lastInitialOf(p.name)}`.trim())
    for (const [i, p] of same.entries()) {
      const label = withInitial[i]
      const clash = withInitial.filter((x) => x.toLowerCase() === label.toLowerCase()).length > 1
      out.set(p.id, clash ? p.name.trim() : label)
    }
  }
  return out
}

// ─── What is open, remembered per browser ─────────────────────────────────────

/** Open/closed state: division headings (by key) and people (by id). */
export interface OpenState {
  divisions: Record<string, boolean>
  people: Record<string, boolean>
}

const empty = (): OpenState => ({ divisions: {}, people: {} })

const isFlags = (v: unknown): v is Record<string, boolean> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.values(v as object).every((x) => typeof x === 'boolean')

/** Read the saved state. Private windows, blocked storage or junk give an empty state. */
export function loadOpen(key: string): OpenState {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (!raw) return empty()
    const v = JSON.parse(raw) as Partial<OpenState>
    return { divisions: isFlags(v.divisions) ? v.divisions : {}, people: isFlags(v.people) ? v.people : {} }
  } catch {
    return empty()
  }
}

/** Save the state. Never throws: the page works the same without storage. */
export function saveOpen(key: string, state: OpenState): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(state))
  } catch {
    /* storage blocked or full: forget it */
  }
}

/** Division headings start open; people start closed. */
export const divisionOpen = (s: OpenState, key: string) => s.divisions[key] ?? true
export const personOpen = (s: OpenState, id: string) => s.people[id] ?? false
