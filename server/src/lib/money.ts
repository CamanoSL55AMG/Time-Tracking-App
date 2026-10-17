import { badRequest } from '../errors.js'

// Money is whole cents everywhere. Mileage rates are tenths of a cent ("mills"),
// because the IRS rate has been a half cent before (65.5¢ in 2023).

/** "12.34", 12.34 or "$1,234.50" → cents. Throws a 400 on anything else. */
export function toCents(v: unknown, field: string): number {
  const s = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.replace(/[$,\s]/g, '') : ''
  if (!/^-?\d+(\.\d{1,2})?$/.test(s)) throw badRequest(`${field} must be an amount like 12.34.`, { field })
  const [whole, frac = ''] = s.replace('-', '').split('.')
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'))
  return s.startsWith('-') ? -cents : cents
}

/** Amount for a mileage line: miles × rate, to the nearest cent. */
export const mileageCents = (miles: number, rateMills: number): number => Math.round((miles * rateMills) / 10)

/** "72.5" (cents per mile) → 725 mills. */
export function centsPerMileToMills(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0 || n > 1000) throw badRequest(`${field} must be cents per mile, like 72.5.`, { field })
  return Math.round(n * 10)
}

export const fmtDollars = (cents: number): string => `${cents < 0 ? '-' : ''}$${(Math.abs(cents) / 100).toFixed(2)}`
