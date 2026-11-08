// Matching for the job search box. Pure, so it can be checked without a browser.
//
// A job matches when every word typed appears in its number, name or client.
// Punctuation is ignored for the number, so "p1025", "P 1025" and "1025" all find
// P-1025. Best matches come first: the number itself, then numbers and names that
// start with what was typed, then anything that contains it.

export interface MatchableJob {
  name: string
  code: string
  clientName?: string
}

const lower = (s: string | undefined) => (s ?? '').toLowerCase()
const compact = (s: string) => s.replace(/[^a-z0-9]/g, '')

function rank(j: MatchableJob, q: string): number {
  const code = lower(j.code)
  const name = lower(j.name)
  const qc = compact(q)
  if (code && (code === q || (qc && compact(code) === qc))) return 0
  if (code.startsWith(q) || (qc && compact(code).startsWith(qc))) return 1
  if (name.startsWith(q)) return 2
  if (name.split(/[^a-z0-9]+/).some((w) => w && w.startsWith(q))) return 3
  return 4
}

function matches(j: MatchableJob, words: string[]): boolean {
  const hay = `${lower(j.code)} ${lower(j.name)} ${lower(j.clientName)}`
  const hayCompact = compact(hay)
  return words.every((w) => hay.includes(w) || (compact(w) !== '' && hayCompact.includes(compact(w))))
}

/** The jobs that match `query`, best first, at most `limit`. An empty query matches nothing. */
export function searchJobs<T extends MatchableJob>(jobs: T[], query: string, limit = 8): T[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const words = q.split(/\s+/)
  return jobs
    .filter((j) => matches(j, words))
    .map((j) => ({ j, r: rank(j, q) }))
    .sort((a, b) => a.r - b.r || a.j.name.localeCompare(b.j.name))
    .slice(0, limit)
    .map((x) => x.j)
}
