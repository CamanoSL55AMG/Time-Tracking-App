import test from 'node:test'
import assert from 'node:assert/strict'
import {
  completeMonths,
  completeWeeks,
  daysBetween,
  earnedForHours,
  forfeitAtYearEnd,
  grantDates,
  parseTiers,
  rateOn,
  underCap,
  usableFrom,
  weekStart,
  yearsOfService,
} from './leave.js'
import { mileageCents, toCents } from './money.js'

test('WA sick leave: 1 hour for every 40 worked, fractions kept', () => {
  assert.equal(earnedForHours(40, 1, 40), 1)
  assert.equal(earnedForHours(7.5, 1, 40), 0.1875)
  assert.equal(earnedForHours(0, 1, 40), 0)
  assert.equal(earnedForHours(-3, 1, 40), 0)
})

test('sick leave is usable from the 90th calendar day after starting', () => {
  assert.equal(usableFrom('2026-01-01', 90), '2026-04-01')
  assert.equal(usableFrom(null, 90), null)
  assert.equal(usableFrom('2026-01-01', 0), '2026-01-01')
})

test('carryover above the limit is forfeited at year end', () => {
  assert.equal(forfeitAtYearEnd(52.25, 40), 12.25)
  assert.equal(forfeitAtYearEnd(39, 40), 0)
  assert.equal(forfeitAtYearEnd(500, null), 0)
})

test('a cap stops accrual without going over', () => {
  assert.equal(underCap(78, 4, 80), 2)
  assert.equal(underCap(80, 4, 80), 0)
  assert.equal(underCap(90, 4, 80), 0)
  assert.equal(underCap(10, 4, null), 4)
})

test('years of service count whole years from the start date', () => {
  assert.equal(yearsOfService('2020-06-15', '2026-06-14'), 5)
  assert.equal(yearsOfService('2020-06-15', '2026-06-15'), 6)
  assert.equal(yearsOfService(null, '2026-06-15'), 0)
  assert.equal(yearsOfService('2027-01-01', '2026-06-15'), 0)
})

test('service tiers raise the rate once reached', () => {
  const rule = { rateHours: 1, tiers: [{ afterYears: 5, rateHours: 2 }, { afterYears: 2, rateHours: 1.5 }] }
  assert.equal(rateOn(rule, '2020-01-01', '2021-06-01'), 1)
  assert.equal(rateOn(rule, '2020-01-01', '2023-06-01'), 1.5)
  assert.equal(rateOn(rule, '2020-01-01', '2026-06-01'), 2)
})

test('weeks run Monday to Sunday and only complete ones count', () => {
  assert.equal(weekStart('2026-10-17'), '2026-10-12') // Saturday → Monday
  assert.equal(weekStart('2026-10-12'), '2026-10-12')
  assert.equal(weekStart('2026-10-18'), '2026-10-12') // Sunday belongs to the same week
  assert.deepEqual(completeWeeks('2026-10-01', '2026-10-18'), ['2026-09-28', '2026-10-05', '2026-10-12'])
  assert.deepEqual(completeWeeks('2026-10-01', '2026-10-17'), ['2026-09-28', '2026-10-05'])
})

test('months count only once they are over', () => {
  assert.deepEqual(completeMonths('2026-08-15', '2026-10-17'), ['2026-08', '2026-09'])
  assert.deepEqual(completeMonths('2026-11-01', '2027-01-31'), ['2026-11', '2026-12', '2027-01'])
})

test('annual grants on 1 January or the work anniversary', () => {
  assert.deepEqual(grantDates('calendar', null, '2025-06-01', '2026-10-17'), ['2026-01-01'])
  assert.deepEqual(grantDates('anniversary', '2024-03-10', '2024-01-01', '2026-10-17'), ['2025-03-10', '2026-03-10'])
  assert.deepEqual(grantDates('anniversary', '2024-02-29', '2025-01-01', '2025-12-31'), ['2025-02-28'])
  assert.deepEqual(grantDates('anniversary', null, '2025-01-01', '2025-12-31'), [])
})

test('day counts and tier parsing', () => {
  assert.equal(daysBetween('2026-10-01', '2026-10-17'), 16)
  assert.deepEqual(parseTiers([{ afterYears: 3, rateHours: 1.5 }, { afterYears: 'x' }, null]), [{ afterYears: 3, rateHours: 1.5 }])
  assert.deepEqual(parseTiers('nope'), [])
})

test('money is whole cents; mileage is miles × rate', () => {
  assert.equal(toCents('12.34', 'amount'), 1234)
  assert.equal(toCents('$1,234.5', 'amount'), 123450)
  assert.equal(toCents(7, 'amount'), 700)
  assert.throws(() => toCents('12.345', 'amount'))
  assert.throws(() => toCents('abc', 'amount'))
  assert.equal(mileageCents(42.3, 725), 3067) // 42.3 mi × 72.5¢ = $30.67
  assert.equal(mileageCents(10, 655), 655)
})
