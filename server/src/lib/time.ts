// Day boundaries in the company's timezone. The server stores UTC; "today" for a
// tech in Lynnwood is not the UTC day.

/** Offset of `tz` from UTC at the instant `at`, in milliseconds (negative west of UTC). */
export function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return asUtc - Math.floor(at.getTime() / 1000) * 1000
}

/** Calendar date (YYYY-MM-DD) of the instant `at` as seen in `tz`. */
export function localDate(at: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

/** The UTC instant at which the calendar date `ymd` starts in `tz`. */
export function startOfLocalDay(ymd: string, tz: string): Date {
  const [y, m, d] = ymd.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  // Two passes settle the offset on daylight-saving change days.
  let start = guess - tzOffsetMs(new Date(guess), tz)
  start = guess - tzOffsetMs(new Date(start), tz)
  return new Date(start)
}

/** Add whole calendar days to a YYYY-MM-DD date. */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** [start, end) of the local day containing `at`. */
export function dayBounds(at: Date, tz: string): { start: Date; end: Date; date: string } {
  const date = localDate(at, tz)
  return { start: startOfLocalDay(date, tz), end: startOfLocalDay(addDays(date, 1), tz), date }
}

export const isYmd = (s: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

/** Hours between two instants; an open segment runs to `now`. */
export function hoursBetween(clockIn: Date, clockOut: Date | null, now = new Date()): number {
  return Math.max(0, ((clockOut ?? now).getTime() - clockIn.getTime()) / 3_600_000)
}
