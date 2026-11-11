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

// ─── Fixing your own time ───────────────────────────────────────────────────
// A tech may correct their own segments back to the start of the open pay period
// (Art, 2026-11-09): no approval first, but every change keeps the old times and
// shows as edited for a supervisor to look over. Older time still goes through a
// change request. These rules are pure so they can be tested without a database.

/**
 * First day of the pay period holding `ymd`. Morgan Sound pays twice a month: the 1st
 * to the 15th and the 16th to month end (the same periods as payroll.ts).
 */
export function payPeriodStart(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return `${y}-${String(m).padStart(2, '0')}-${d <= 15 ? '01' : '16'}`
}

export interface Span {
  id: string
  clockIn: Date
  clockOut: Date | null
}

export interface TimesChange {
  clockIn?: Date
  /** A new end. An open segment may be closed this way (a missed clock-out); never reopened. */
  clockOut?: Date
}

export type PlanProblem =
  | { code: 'not_found' }
  | { code: 'nothing_to_change' }
  | { code: 'end_before_start' }
  | { code: 'too_long' }
  | { code: 'swallows'; neighbourId: string; side: 'before' | 'after' }
  | { code: 'overlap'; neighbourId: string }

export interface PlannedSpan {
  id: string
  clockIn: Date
  clockOut: Date | null
  /** Which edge moved: the tech's own change, or the neighbour kept joined to it. */
  why: 'changed' | 'joined_before' | 'joined_after'
}

export interface Plan {
  updates: PlannedSpan[]
  /** The change leaves time off the clock where two segments used to meet. */
  opensGap: boolean
}

const MAX_SEGMENT_MS = 24 * 3_600_000
const t = (d: Date | null | undefined) => (d ? d.getTime() : null)

/**
 * Works out every row a change to one segment's times touches. Segments that meet
 * (a job or phase switch: one ends at the instant the next starts) stay joined when
 * `keepJoined` is on, so moving a switch moves both sides of it and leaves no gap and
 * no overlap. A change that would leave a neighbour with no time, or run into a
 * segment it does not meet, is refused instead of fixed silently.
 *
 * `segments` are the person's segments around the one being changed, in any order.
 */
export function planTimesChange(segments: Span[], targetId: string, change: TimesChange, keepJoined = true): Plan | { problem: PlanProblem } {
  const segs = [...segments].sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime())
  const i = segs.findIndex((s) => s.id === targetId)
  if (i < 0) return { problem: { code: 'not_found' } }
  const target = segs[i]
  const prev = i > 0 ? segs[i - 1] : null
  const next = i < segs.length - 1 ? segs[i + 1] : null

  const newIn = change.clockIn ?? target.clockIn
  const newOut = change.clockOut ?? target.clockOut
  const inMoved = newIn.getTime() !== target.clockIn.getTime()
  const outMoved = t(newOut) !== t(target.clockOut)
  if (!inMoved && !outMoved) return { problem: { code: 'nothing_to_change' } }
  if (newOut && newOut.getTime() <= newIn.getTime()) return { problem: { code: 'end_before_start' } }
  if (newOut && newOut.getTime() - newIn.getTime() > MAX_SEGMENT_MS) return { problem: { code: 'too_long' } }

  const updates: PlannedSpan[] = [{ id: target.id, clockIn: newIn, clockOut: newOut, why: 'changed' }]
  let opensGap = false

  if (inMoved && prev) {
    const joined = t(prev.clockOut) === target.clockIn.getTime()
    if (joined && keepJoined) {
      if (newIn.getTime() <= prev.clockIn.getTime()) return { problem: { code: 'swallows', neighbourId: prev.id, side: 'before' } }
      updates.unshift({ id: prev.id, clockIn: prev.clockIn, clockOut: newIn, why: 'joined_before' })
    } else {
      // An open segment before this one cannot exist (one open segment, and it is the last).
      if (prev.clockOut && newIn.getTime() < prev.clockOut.getTime()) return { problem: { code: 'overlap', neighbourId: prev.id } }
      if (joined && newIn.getTime() > target.clockIn.getTime()) opensGap = true
    }
  }

  if (outMoved && next && target.clockOut) {
    const joined = next.clockIn.getTime() === target.clockOut.getTime()
    if (joined && keepJoined && newOut) {
      if (next.clockOut && newOut.getTime() >= next.clockOut.getTime()) return { problem: { code: 'swallows', neighbourId: next.id, side: 'after' } }
      updates.push({ id: next.id, clockIn: newOut, clockOut: next.clockOut, why: 'joined_after' })
    } else {
      if (newOut && newOut.getTime() > next.clockIn.getTime()) return { problem: { code: 'overlap', neighbourId: next.id } }
      if (joined && newOut && newOut.getTime() < target.clockOut.getTime()) opensGap = true
    }
  } else if (outMoved && next && !target.clockOut && newOut && newOut.getTime() > next.clockIn.getTime()) {
    return { problem: { code: 'overlap', neighbourId: next.id } }
  }

  // Whatever the edges did, the day as a whole must still be clean: every segment has
  // time, and none runs into the next.
  const moved = new Map(updates.map((u) => [u.id, u]))
  const after = segs.map((s) => moved.get(s.id) ?? s).sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime())
  for (let k = 0; k < after.length; k++) {
    const s = after[k]
    if (s.clockOut && s.clockOut.getTime() <= s.clockIn.getTime()) return { problem: { code: 'end_before_start' } }
    const n = after[k + 1]
    if (n && (!s.clockOut || s.clockOut.getTime() > n.clockIn.getTime())) return { problem: { code: 'overlap', neighbourId: n.id === targetId ? s.id : n.id } }
  }
  return { updates, opensGap }
}
