// Catch a likely AM/PM slip before a typed time saves (Art, 2026-11-12: Nate's
// clock-in went in as 6:19 PM instead of 6:19 AM and the day showed 14.6 hours).
// A warning, never a block: night work happens, so "Keep as entered" always works.
// Same windows as the server's review flag (server/src/lib/amPm.ts).
//
// Times are datetime-local strings ("2026-11-12T06:19") in this browser's time zone,
// exactly what the time fields hold.

/** Clock-ins at or after this hour look like a PM slip. */
export const ODD_START_FROM_H = 17
/** Clock-ins before this hour look like an AM slip. */
export const ODD_START_BEFORE_H = 4
/** A shift longer than this is long enough to question. */
export const LONG_SHIFT_H = 12
/** A switch is only offered when it gives at least this long a shift. */
const MIN_FIX_SHIFT_H = 2

export interface TimeFix {
  /** Button text, e.g. "Switch to 6:19 AM". */
  label: string
  clockIn: string
  clockOut: string
}

export interface TimeWarning {
  /** The question, e.g. "Clock-in at 6:19 PM?" */
  title: string
  /** e.g. "Did you mean 6:19 AM?" when there is a likely fix. */
  question?: string
  /** What looks wrong, one short sentence each. */
  lines: string[]
  fix?: TimeFix
}

const HOUR_MS = 3_600_000

const pad = (n: number) => String(n).padStart(2, '0')
const toInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const parse = (v: string): Date | null => {
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export const fmtClock = (d: Date) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const fmtDayClock = (d: Date) => `${d.toLocaleDateString('en-US', { weekday: 'short' })} ${fmtClock(d)}`

/** True when a clock-in at this hour is outside the usual working day. */
export const oddStartHour = (hour: number) => hour >= ODD_START_FROM_H || hour < ODD_START_BEFORE_H

/** The same wall time on the same date, other half of the clock (6:19 PM -> 6:19 AM). */
function flipHalf(d: Date): Date {
  const out = new Date(d)
  out.setHours(d.getHours() >= 12 ? d.getHours() - 12 : d.getHours() + 12)
  return out
}

/** The same wall time on the next calendar date. */
function nextDay(d: Date): Date {
  const out = new Date(d)
  out.setDate(d.getDate() + 1)
  return out
}

const hoursBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / HOUR_MS
const sameDate = (a: Date, b: Date) => a.toDateString() === b.toDateString()

/**
 * What looks off about a start and end, or null when nothing does.
 * `clockOut` is '' for a segment still on the clock.
 */
export function checkTimes(clockIn: string, clockOut: string): TimeWarning | null {
  const inD = parse(clockIn)
  if (!inD) return null
  const outD = parse(clockOut)

  const oddIn = oddStartHour(inD.getHours())
  const span = outD ? hoursBetween(inD, outD) : null
  const backwards = span !== null && span <= 0
  const long = span !== null && span > LONG_SHIFT_H
  if (!oddIn && !backwards && !long) return null

  const lines: string[] = []
  if (backwards) lines.push(`Clock-out (${fmtDayClock(outD!)}) is not after clock-in (${fmtDayClock(inD)}).`)
  if (long) lines.push(`That makes a ${span!.toFixed(1)} hour shift.`)

  // One change that gives a normal shift, the likeliest first.
  type Candidate = { which: 'in' | 'out'; inD: Date; outD: Date | null }
  const candidates: Candidate[] = []
  const inFlip = flipHalf(inD)
  candidates.push({ which: 'in', inD: inFlip, outD })
  // The start went in on the evening before (6:19 PM Tue for 6:19 AM Wed).
  if (outD && !sameDate(inD, outD)) {
    const onOutDate = new Date(outD)
    onOutDate.setHours(inFlip.getHours(), inFlip.getMinutes(), 0, 0)
    candidates.push({ which: 'in', inD: onOutDate, outD })
  }
  if (outD) {
    candidates.push({ which: 'out', inD, outD: flipHalf(outD) })
    if (backwards) candidates.push({ which: 'out', inD, outD: nextDay(outD) })
  }
  if (!oddIn) candidates.reverse() // a normal start: the end is the likelier slip
  const ok = (c: Candidate) => {
    if (c.outD) {
      const h = hoursBetween(c.inD, c.outD)
      if (h < MIN_FIX_SHIFT_H || h > LONG_SHIFT_H) return false
    }
    // Moving a start into the evening is never the fix; a night start may keep its start.
    return !(c.which === 'in' && oddStartHour(c.inD.getHours()))
  }
  const pick = candidates.find(ok)

  if (!pick) {
    if (oddIn) lines.unshift(`Clock-in is at ${fmtClock(inD)}, outside the usual day.`)
    return { title: 'Check these times', lines }
  }
  if (pick.which === 'in') {
    const when = sameDate(pick.inD, inD) ? fmtClock(pick.inD) : fmtDayClock(pick.inD)
    return {
      title: `Clock-in at ${sameDate(pick.inD, inD) ? fmtClock(inD) : fmtDayClock(inD)}?`,
      question: `Did you mean ${when}?`,
      lines,
      fix: { label: `Switch to ${when}`, clockIn: toInput(pick.inD), clockOut: clockOut },
    }
  }
  const when = sameDate(pick.outD!, outD!) ? fmtClock(pick.outD!) : fmtDayClock(pick.outD!)
  return {
    title: `Clock-out at ${sameDate(pick.outD!, outD!) ? fmtClock(outD!) : fmtDayClock(outD!)}?`,
    question: `Did you mean ${when}?`,
    lines,
    fix: { label: `Switch clock-out to ${when}`, clockIn: clockIn, clockOut: toInput(pick.outD!) },
  }
}
