import { addDays, isYmd } from '../lib/time.js'

// Leave rules that need no database, so they can be tested on their own.
// TIME-TRACKING-APP.md §7. Washington paid sick leave as published by L&I
// (lni.wa.gov/workers-rights/leave/paid-sick-leave, read 2026-10-07).

export const LEDGER_KINDS = ['accrual', 'use', 'adjustment', 'carryover', 'forfeit', 'payout', 'reinstate'] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]

export const POLICY_METHODS = ['per_hours_worked', 'per_period', 'annual_grant', 'none'] as const
export type PolicyMethod = (typeof POLICY_METHODS)[number]

/** Washington's floor: at least 1 hour for every 40 hours worked. */
export const WA_SICK_MIN_RATE = 1 / 40
/** An unused balance of up to 40 hours has to carry over to the next year. */
export const WA_SICK_MIN_CARRYOVER = 40
/** Usable from the 90th calendar day after the start of employment. */
export const WA_SICK_WAITING_DAYS = 90

export interface Tier {
  years: number
  rateHours?: number
  periodHours?: number
}

export interface PolicyRules {
  method: string
  rateHours: number
  perHours: number
  periodHours: number
  grantOn: string
  tiers: unknown
  balanceCap: number | null
  carryoverMax: number | null
  waitingDays: number
}

/** Round up to the hundredth, so a rounded accrual never falls under the rate. */
export const ceil2 = (n: number) => Math.ceil(Math.round(n * 1e6) / 1e4) / 100
export const round2 = (n: number) => Math.round(n * 100) / 100

/** Whole years from the hire date to `date`. 0 without a hire date. */
export function yearsOfService(hireDate: string | null | undefined, date: string): number {
  if (!hireDate || !isYmd(hireDate) || date < hireDate) return 0
  const [hy, hm, hd] = hireDate.split('-').map(Number)
  const [y, m, d] = date.split('-').map(Number)
  let years = y - hy
  if (m < hm || (m === hm && d < hd)) years -= 1
  return Math.max(0, years)
}

export function parseTiers(raw: unknown): Tier[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((t) => t as Record<string, unknown>)
    .filter((t) => t && Number.isFinite(Number(t.years)))
    .map((t) => ({
      years: Number(t.years),
      ...(t.rateHours !== undefined && Number.isFinite(Number(t.rateHours)) ? { rateHours: Number(t.rateHours) } : {}),
      ...(t.periodHours !== undefined && Number.isFinite(Number(t.periodHours)) ? { periodHours: Number(t.periodHours) } : {}),
    }))
    .sort((a, b) => a.years - b.years)
}

/** The policy as it applies after `years` of service: the highest tier reached wins. */
export function effectiveRates(policy: PolicyRules, years: number): { rateHours: number; periodHours: number } {
  let rateHours = policy.rateHours
  let periodHours = policy.periodHours
  for (const t of parseTiers(policy.tiers)) {
    if (t.years > years) break
    if (t.rateHours !== undefined) rateHours = t.rateHours
    if (t.periodHours !== undefined) periodHours = t.periodHours
  }
  return { rateHours, periodHours }
}

/**
 * Hours earned in one pay period. per_hours_worked counts every hour worked
 * (overtime and travel included, Art 2026-11-07); leave taken is not work and earns
 * nothing. per_period earns a fixed amount. Grants are handled by grantDatesIn.
 */
export function earnedInPeriod(policy: PolicyRules, hoursWorked: number, years: number): number {
  const { rateHours, periodHours } = effectiveRates(policy, years)
  if (policy.method === 'per_hours_worked') {
    if (policy.perHours <= 0 || hoursWorked <= 0) return 0
    return ceil2((hoursWorked * rateHours) / policy.perHours)
  }
  if (policy.method === 'per_period') return round2(Math.max(0, periodHours))
  return 0
}

/** What may be added without going past the cap. balanceBefore excludes this period's own accrual. */
export function underCap(earned: number, balanceBefore: number, cap: number | null): number {
  if (cap === null || cap === undefined) return earned
  return round2(Math.max(0, Math.min(earned, cap - balanceBefore)))
}

/** Grant days (Jan 1, or the work anniversary) that fall in [from, to]. */
export function grantDatesIn(policy: PolicyRules, hireDate: string | null | undefined, from: string, to: string): string[] {
  if (policy.method !== 'annual_grant') return []
  const out: string[] = []
  const fy = Number(from.slice(0, 4))
  const ty = Number(to.slice(0, 4))
  for (let y = fy; y <= ty; y++) {
    let day: string
    if (policy.grantOn === 'anniversary') {
      if (!hireDate || !isYmd(hireDate)) continue
      const md = hireDate.slice(5) === '02-29' ? '02-28' : hireDate.slice(5)
      day = `${y}-${md}`
      if (day <= hireDate) continue // the hire date itself is not an anniversary
    } else {
      day = `${y}-01-01`
    }
    if (day >= from && day <= to) out.push(day)
  }
  return out
}

/** The first day leave of this kind can be used, or null when there is no wait or no hire date. */
export function usableFrom(hireDate: string | null | undefined, waitingDays: number): string | null {
  if (!hireDate || !isYmd(hireDate) || !waitingDays || waitingDays <= 0) return null
  return addDays(hireDate, waitingDays)
}

/** Hours over the carryover limit at year end, to forfeit. */
export function overCarryover(balance: number, carryoverMax: number | null): number {
  if (carryoverMax === null || carryoverMax === undefined) return 0
  return round2(Math.max(0, balance - carryoverMax))
}

/**
 * A sick-leave (or combined PTO) policy has to meet every Washington rule: accrue
 * from hours worked at 1 per 40 or better, no cap on what is earned in the year,
 * carry over at least 40 hours, and wait no more than 90 days. Returns what is wrong.
 */
export function waSickProblems(p: PolicyRules): string[] {
  const problems: string[] = []
  if (p.method !== 'per_hours_worked') problems.push('Washington sick leave has to be earned from hours worked.')
  else if (p.perHours <= 0 || p.rateHours / p.perHours < WA_SICK_MIN_RATE - 1e-9) problems.push('Washington sick leave has to be at least 1 hour for every 40 hours worked.')
  if (p.balanceCap !== null && p.balanceCap !== undefined) problems.push('Washington sick leave cannot stop accruing at a cap during the year.')
  if (p.carryoverMax !== null && p.carryoverMax !== undefined && p.carryoverMax < WA_SICK_MIN_CARRYOVER) problems.push('Washington sick leave has to carry over at least 40 hours.')
  if (p.waitingDays > WA_SICK_WAITING_DAYS) problems.push('Washington sick leave has to be usable from the 90th day after hire.')
  return problems
}

/** The Washington sick leave preset. Rate, cap and carryover can be raised, not lowered. */
export const WA_SICK_PRESET: PolicyRules & { name: string } = {
  name: 'Washington paid sick leave',
  method: 'per_hours_worked',
  rateHours: 1,
  perHours: 40,
  periodHours: 0,
  grantOn: 'jan1',
  tiers: [],
  balanceCap: null,
  carryoverMax: WA_SICK_MIN_CARRYOVER,
  waitingDays: WA_SICK_WAITING_DAYS,
}

export interface LeaveDay {
  date: string
  hours: number
}

/**
 * The days a request covers. Given days are used as they are; otherwise every
 * weekday from start to end gets hoursPerDay (weekends only when asked).
 */
export function expandDays(start: string, end: string, hoursPerDay: number, includeWeekends = false): LeaveDay[] {
  const out: LeaveDay[] = []
  for (let d = start; d <= end && out.length < 400; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay()
    if (!includeWeekends && (dow === 0 || dow === 6)) continue
    out.push({ date: d, hours: hoursPerDay })
  }
  return out
}

/** Checks the days of a request. Returns a message for the first problem, or null. */
export function daysProblem(days: LeaveDay[], start: string, end: string): string | null {
  if (!isYmd(start) || !isYmd(end)) return 'Start and end must be dates, YYYY-MM-DD.'
  if (end < start) return 'The last day must be on or after the first.'
  if (addDays(start, 366) < end) return 'A request can cover a year at most.'
  if (!days.length) return 'Those dates hold no work days. Pick other dates or include the weekend.'
  const seen = new Set<string>()
  for (const d of days) {
    if (!isYmd(d.date) || d.date < start || d.date > end) return `${d.date} is outside the dates asked for.`
    if (seen.has(d.date)) return `${d.date} is listed twice.`
    seen.add(d.date)
    if (!Number.isFinite(d.hours) || d.hours < 0 || d.hours > 24) return 'Hours on a day must be between 0 and 24.'
  }
  return null
}

export const sumHours = (days: LeaveDay[]) => round2(days.reduce((t, d) => t + d.hours, 0))
