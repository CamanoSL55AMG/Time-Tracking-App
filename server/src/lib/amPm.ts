// Likely AM/PM slips (Art, 2026-11-12: Nate's clock-in saved as 6:19 PM, not AM,
// giving a 14.6-hour day). A start between 5 PM and 4 AM is unusual for this crew
// but night work happens, so on its own it is not a problem. Together with a day
// over 12 hours it almost always means the wrong half of the clock was picked.
// The same windows drive the confirm pop-up in client/src/timeCheck.ts.

/** Clock-ins at or after this hour (local) look like a PM slip. */
export const ODD_START_FROM_H = 17
/** Clock-ins before this hour (local) look like an AM slip. */
export const ODD_START_BEFORE_H = 4
/** A day or shift longer than this is long enough to question. */
export const LONG_SHIFT_H = 12

/** Hour of the day (0-23) of the instant `at` on the wall in `tz`. */
export function localHour(at: Date, tz: string): number {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', hour: 'numeric' }).format(at))
  return h === 24 ? 0 : h
}

/** True when a clock-in at this local hour is outside the usual working day. */
export const oddStartHour = (hour: number): boolean => hour >= ODD_START_FROM_H || hour < ODD_START_BEFORE_H

/**
 * The day's start looks like an AM/PM slip: it began at an odd hour and the day ran
 * long. `firstIn` is the earliest clock-in of the day, `hours` the day's total.
 */
export function suspectAmPm(firstIn: Date, hours: number, tz: string): boolean {
  return oddStartHour(localHour(firstIn, tz)) && hours > LONG_SHIFT_H
}
