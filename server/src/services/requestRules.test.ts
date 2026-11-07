import { test } from 'node:test'
import assert from 'node:assert/strict'
import { earliestRequestDate, requestWindowProblem } from './requestRules.js'

const TZ = 'America/Los_Angeles'
// Wed Nov 4 2026, 9:00 am Pacific (PST, UTC-8)
const now = new Date('2026-11-04T17:00:00Z')

test('the window counts whole local days back from today', () => {
  assert.equal(earliestRequestDate('2026-11-04', 21), '2026-10-14')
  assert.equal(earliestRequestDate('2026-11-01', 1), '2026-10-31')
})

test('0 or a bad number means no limit', () => {
  assert.equal(earliestRequestDate('2026-11-04', 0), null)
  assert.equal(earliestRequestDate('2026-11-04', Number.NaN), null)
  assert.equal(requestWindowProblem([new Date('2020-01-01T15:00:00Z')], now, TZ, 0), null)
})

test('this morning and last week are fine', () => {
  assert.equal(requestWindowProblem([new Date('2026-11-04T15:00:00Z')], now, TZ, 21), null)
  assert.equal(requestWindowProblem([new Date('2026-10-28T15:00:00Z'), new Date('2026-10-28T23:30:00Z')], now, TZ, 21), null)
})

test('the first day of the window is still open, the day before is not', () => {
  // Oct 14 07:00 Pacific (PDT, UTC-7) is inside; Oct 13 23:30 Pacific is outside.
  assert.equal(requestWindowProblem([new Date('2026-10-14T14:00:00Z')], now, TZ, 21), null)
  assert.deepEqual(requestWindowProblem([new Date('2026-10-14T06:30:00Z')], now, TZ, 21), { code: 'too_old', earliest: '2026-10-14' })
})

test('the day is the company day, not the UTC day', () => {
  // 4:30 pm Pacific on Oct 13 is already Oct 14 in UTC, but it is Oct 13 for the tech.
  assert.deepEqual(requestWindowProblem([new Date('2026-10-14T00:30:00Z')], now, TZ, 21), { code: 'too_old', earliest: '2026-10-14' })
})

test('any one time outside the window is enough to refuse', () => {
  const r = requestWindowProblem([new Date('2026-11-03T15:00:00Z'), new Date('2026-09-01T15:00:00Z')], now, TZ, 21)
  assert.equal(r?.code, 'too_old')
})

test('times in the future are refused, with a few minutes of slack for phone clocks', () => {
  assert.equal(requestWindowProblem([new Date(now.getTime() + 2 * 60_000)], now, TZ, 21), null)
  assert.deepEqual(requestWindowProblem([new Date(now.getTime() + 60 * 60_000)], now, TZ, 21), { code: 'future' })
})
