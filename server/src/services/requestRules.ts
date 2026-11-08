import { addDays, localDate } from '../lib/time.js'

// How far back a person may ask for their own time to be changed. Pure, so it can be
// tested without a database. Approved weeks are refused separately (requests.ts):
// once a week is approved, a supervisor reopens it and corrects it directly.

/** Requested times may run this far past "now" (phone clocks drift). */
export const FUTURE_SLACK_MS = 5 * 60_000

export type WindowProblem = { code: 'future' } | { code: 'too_old'; earliest: string } | null

/** The first local date a person may still ask about, or null when there is no limit. */
export function earliestRequestDate(today: string, days: number): string | null {
  if (!Number.isFinite(days) || days <= 0) return null
  return addDays(today, -Math.floor(days))
}

/**
 * Whether a request touching these instants is out of reach. `days` = how many days
 * before today are still open (0 = no limit). Today always is.
 */
export function requestWindowProblem(times: Date[], now: Date, tz: string, days: number): WindowProblem {
  if (times.some((t) => t.getTime() > now.getTime() + FUTURE_SLACK_MS)) return { code: 'future' }
  const earliest = earliestRequestDate(localDate(now, tz), days)
  if (earliest && times.some((t) => localDate(t, tz) < earliest)) return { code: 'too_old', earliest }
  return null
}
