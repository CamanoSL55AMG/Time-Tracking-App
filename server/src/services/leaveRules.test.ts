import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ceil2,
  daysProblem,
  earnedInPeriod,
  effectiveRates,
  expandDays,
  grantDatesIn,
  overCarryover,
  underCap,
  usableFrom,
  waSickProblems,
  WA_SICK_PRESET,
  yearsOfService,
  type PolicyRules,
} from './leaveRules.js'

const sick: PolicyRules = { ...WA_SICK_PRESET }

test('WA sick leave: 1 hour per 40 worked, overtime hours count the same', () => {
  assert.equal(earnedInPeriod(sick, 40, 0), 1)
  assert.equal(earnedInPeriod(sick, 88, 0), 2.2) // 80 regular + 8 overtime: all hours worked count
  assert.equal(earnedInPeriod(sick, 0, 0), 0)
})

test('accrual rounds up to the hundredth, never under the rate', () => {
  assert.equal(earnedInPeriod(sick, 7.5, 0), 0.19) // 0.1875
  assert.equal(earnedInPeriod(sick, 12, 0), 0.3) // 0.3 exactly, no float creep to 0.31
  assert.equal(ceil2(0.30000000000000004), 0.3)
})

test('the WA preset itself meets every rule', () => {
  assert.deepEqual(waSickProblems(sick), [])
})

test('a sick policy below the state floor is refused', () => {
  assert.equal(waSickProblems({ ...sick, rateHours: 1, perHours: 50 }).length, 1)
  assert.equal(waSickProblems({ ...sick, balanceCap: 48 }).length, 1)
  assert.equal(waSickProblems({ ...sick, carryoverMax: 24 }).length, 1)
  assert.equal(waSickProblems({ ...sick, waitingDays: 120 }).length, 1)
  assert.equal(waSickProblems({ ...sick, method: 'annual_grant' }).length, 1)
})

test('a sick policy can be more generous than the state', () => {
  assert.deepEqual(waSickProblems({ ...sick, rateHours: 1, perHours: 30, carryoverMax: 80, waitingDays: 0 }), [])
  assert.deepEqual(waSickProblems({ ...sick, carryoverMax: null }), [])
})

test('per-period and tiers by years of service', () => {
  const vac: PolicyRules = { ...sick, method: 'per_period', periodHours: 3.33, tiers: [{ years: 5, periodHours: 5 }, { years: 10, periodHours: 6.67 }], carryoverMax: 80, waitingDays: 0 }
  assert.equal(earnedInPeriod(vac, 0, 2), 3.33)
  assert.equal(earnedInPeriod(vac, 0, 5), 5)
  assert.equal(earnedInPeriod(vac, 0, 12), 6.67)
  assert.deepEqual(effectiveRates({ ...sick, tiers: [{ years: 3, rateHours: 1.5 }] }, 4), { rateHours: 1.5, periodHours: 0 })
})

test('years of service count whole years from the hire date', () => {
  assert.equal(yearsOfService('2020-06-15', '2026-06-14'), 5)
  assert.equal(yearsOfService('2020-06-15', '2026-06-15'), 6)
  assert.equal(yearsOfService(null, '2026-06-15'), 0)
})

test('balance cap: accrual stops at the cap', () => {
  assert.equal(underCap(4, 78, 80), 2)
  assert.equal(underCap(4, 82, 80), 0)
  assert.equal(underCap(4, 10, null), 4)
})

test('grants on Jan 1 or the work anniversary', () => {
  const grant: PolicyRules = { ...sick, method: 'annual_grant', periodHours: 40, grantOn: 'jan1' }
  assert.deepEqual(grantDatesIn(grant, null, '2026-12-16', '2027-01-15'), ['2027-01-01'])
  assert.deepEqual(grantDatesIn({ ...grant, grantOn: 'anniversary' }, '2019-03-10', '2026-03-01', '2026-03-15'), ['2026-03-10'])
  assert.deepEqual(grantDatesIn({ ...grant, grantOn: 'anniversary' }, '2026-03-10', '2026-03-01', '2026-03-15'), []) // hire day is not an anniversary
  assert.deepEqual(grantDatesIn({ ...grant, grantOn: 'anniversary' }, null, '2026-03-01', '2026-03-15'), [])
})

test('90-day wait after hire', () => {
  assert.equal(usableFrom('2026-11-09', 90), '2027-02-07')
  assert.equal(usableFrom(null, 90), null)
  assert.equal(usableFrom('2026-11-09', 0), null)
})

test('year end: only hours over the carryover limit go', () => {
  assert.equal(overCarryover(52.5, 40), 12.5)
  assert.equal(overCarryover(30, 40), 0)
  assert.equal(overCarryover(300, null), 0)
})

test('request days skip the weekend unless asked', () => {
  const days = expandDays('2026-11-13', '2026-11-17', 8) // Fri to Tue
  assert.deepEqual(days.map((d) => d.date), ['2026-11-13', '2026-11-16', '2026-11-17'])
  assert.equal(expandDays('2026-11-14', '2026-11-15', 8, true).length, 2)
  assert.equal(daysProblem([], '2026-11-14', '2026-11-15'), 'Those dates hold no work days. Pick other dates or include the weekend.')
  assert.equal(daysProblem(days, '2026-11-17', '2026-11-13'), 'The last day must be on or after the first.')
  assert.equal(daysProblem([{ date: '2026-11-13', hours: 25 }], '2026-11-13', '2026-11-13'), 'Hours on a day must be between 0 and 24.')
  assert.equal(daysProblem(days, '2026-11-13', '2026-11-17'), null)
})

