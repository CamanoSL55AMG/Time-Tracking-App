import { addDays } from './time.js'

// Leave arithmetic with no database in it, so the rules can be tested on their own.
// Dates are YYYY-MM-DD calendar dates in the company timezone.

export const LEDGER_KINDS = ['accrual', 'use', 'adjustment', 'carryover', 'forfeit', 'payout', 'reinstate'] as const
export type LedgerKind = (typeof LEDGER_KINDS)[number]

export const ACCRUAL_METHODS = ['per_hours_worked', 'per_month', 'annual_grant'] as const
export type AccrualMethod = (typeof ACCRUAL_METHODS)[number]

export interface Tier {
  afterYears: number
  rateHours: number
}

export interface PolicyRule {
  method: string
  rateHours: number
  perHours: number
  grantOn: string
  capHours: number | null
  carryoverMax: number | null
  waitingDays: number
  tiers: Tier[]
}

/** Hours are kept to 4 decimals: 1 hour per 40 worked over a 7.5 h day is 0.1875. */
export const roundHours = (h: number): number => Math.round(h * 10_000) / 10_000

/** First day the leave may be used, or null when there is no start date to count from. */
export function usableFrom(hireDate: string | null | undefined, waitingDays: number): string | null {
  if (!waitingDays) return hireDate ?? null
  if (!hireDate) return null
  return addDays(hireDate, waitingDays)
}

/** Whole years of service on `on`. */
export function yearsOfService(hireDate: string | null | undefined, on: string): number {
  if (!hireDate || on < hireDate) return 0
  const [hy, hm, hd] = hireDate.split('-').map(Number)
  const [y, m, d] = on.split('-').map(Number)
  let years = y - hy
  if (m < hm || (m === hm && d < hd)) years -= 1
  return Math.max(0, years)
}

/** The rate in force for someone with this start date on `on`, after any service tiers. */
export function rateOn(rule: Pick<PolicyRule, 'rateHours' | 'tiers'>, hireDate: string | null | undefined, on: string): number {
  const years = yearsOfService(hireDate, on)
  let rate = rule.rateHours
  for (const t of [...rule.tiers].sort((a, b) => a.afterYears - b.afterYears)) {
    if (years >= t.afterYears) rate = t.rateHours
  }
  return rate
}

/** Earned for `hoursWorked` at `rate` per `perHours`. */
export function earnedForHours(hoursWorked: number, rate: number, perHours: number): number {
  if (hoursWorked <= 0 || rate <= 0 || perHours <= 0) return 0
  return roundHours((hoursWorked * rate) / perHours)
}

/** What may actually be added without passing the cap. */
export function underCap(balance: number, add: number, cap: number | null): number {
  if (cap === null || cap === undefined) return roundHours(add)
  return roundHours(Math.max(0, Math.min(add, cap - balance)))
}

/** Hours lost at year end when the balance is above the carryover limit. */
export function forfeitAtYearEnd(balance: number, carryoverMax: number | null): number {
  if (carryoverMax === null || carryoverMax === undefined) return 0
  return roundHours(Math.max(0, balance - carryoverMax))
}

/** Monday of the week holding `ymd`. */
export function weekStart(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number)
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay() // 0 Sunday
  return addDays(ymd, -((dow + 6) % 7))
}

/** Mondays of every complete week (Mon–Sun) from the week holding `from` through `through`. */
export function completeWeeks(from: string, through: string): string[] {
  const weeks: string[] = []
  for (let w = weekStart(from); addDays(w, 6) <= through; w = addDays(w, 7)) weeks.push(w)
  return weeks
}

/** YYYY-MM of every complete calendar month from `from` through `through`. */
export function completeMonths(from: string, through: string): string[] {
  const months: string[] = []
  let [y, m] = from.split('-').map(Number)
  for (;;) {
    const ym = `${y}-${String(m).padStart(2, '0')}`
    const last = lastDayOfMonth(ym)
    if (last > through) break
    months.push(ym)
    m += 1
    if (m > 12) {
      m = 1
      y += 1
    }
  }
  return months
}

export function lastDayOfMonth(ym: string): string {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

/** Grant dates of an annual grant that fall in [from, through]. */
export function grantDates(grantOn: string, hireDate: string | null | undefined, from: string, through: string): string[] {
  const out: string[] = []
  const firstYear = Number(from.slice(0, 4))
  const lastYear = Number(through.slice(0, 4))
  for (let y = firstYear; y <= lastYear; y += 1) {
    let date: string
    if (grantOn === 'anniversary') {
      if (!hireDate) return []
      const md = hireDate.slice(5)
      // 29 February hires get 28 February in other years.
      date = md === '02-29' && !isLeap(y) ? `${y}-02-28` : `${y}-${md}`
      if (date <= hireDate) continue // no grant on the first day of work itself
    } else {
      date = `${y}-01-01`
    }
    if (date >= from && date <= through) out.push(date)
  }
  return out
}

const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0

/** Whole calendar days from `a` to `b` (b − a). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000)
}

/** Read a policy's tiers JSON defensively. */
export function parseTiers(v: unknown): Tier[] {
  if (!Array.isArray(v)) return []
  return v
    .map((t) => ({ afterYears: Number((t as Tier)?.afterYears), rateHours: Number((t as Tier)?.rateHours) }))
    .filter((t) => Number.isFinite(t.afterYears) && t.afterYears >= 0 && Number.isFinite(t.rateHours) && t.rateHours >= 0)
}
