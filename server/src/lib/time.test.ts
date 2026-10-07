import test from 'node:test'
import assert from 'node:assert/strict'
import { addDays, dayBounds, hoursBetween, isYmd, localDate, startOfLocalDay, tzOffsetMs } from './time.js'

const LA = 'America/Los_Angeles'

test('offset follows daylight saving', () => {
  assert.equal(tzOffsetMs(new Date('2026-07-01T12:00:00Z'), LA), -7 * 3_600_000)
  assert.equal(tzOffsetMs(new Date('2026-01-15T12:00:00Z'), LA), -8 * 3_600_000)
  assert.equal(tzOffsetMs(new Date('2026-01-15T12:00:00Z'), 'UTC'), 0)
})

test('local date is the date on the wall, not the UTC date', () => {
  // 5:30 PM Pacific on Oct 7 is already Oct 8 in UTC.
  assert.equal(localDate(new Date('2026-10-08T00:30:00Z'), LA), '2026-10-07')
  assert.equal(localDate(new Date('2026-10-08T07:30:00Z'), LA), '2026-10-08')
})

test('a local day starts at local midnight', () => {
  assert.equal(startOfLocalDay('2026-10-07', LA).toISOString(), '2026-10-07T07:00:00.000Z')
  assert.equal(startOfLocalDay('2026-12-07', LA).toISOString(), '2026-12-07T08:00:00.000Z')
})

test('days when the clocks change are 23 and 25 hours long', () => {
  const spring = dayBounds(new Date('2026-03-08T20:00:00Z'), LA)
  assert.equal(spring.date, '2026-03-08')
  assert.equal((spring.end.getTime() - spring.start.getTime()) / 3_600_000, 23)
  const fall = dayBounds(new Date('2026-11-01T20:00:00Z'), LA)
  assert.equal(fall.date, '2026-11-01')
  assert.equal((fall.end.getTime() - fall.start.getTime()) / 3_600_000, 25)
})

test('addDays crosses months and years', () => {
  assert.equal(addDays('2026-10-31', 1), '2026-11-01')
  assert.equal(addDays('2026-12-31', 1), '2027-01-01')
  assert.equal(addDays('2026-03-01', -1), '2026-02-28')
})

test('isYmd', () => {
  assert.equal(isYmd('2026-10-07'), true)
  assert.equal(isYmd('2026-10-07T00:00:00Z'), false)
  assert.equal(isYmd('10/07/2026'), false)
})

test('hoursBetween', () => {
  const a = new Date('2026-10-07T15:00:00Z')
  assert.equal(hoursBetween(a, new Date('2026-10-07T16:30:00Z')), 1.5)
  assert.equal(hoursBetween(a, null, new Date('2026-10-07T15:15:00Z')), 0.25)
  assert.equal(hoursBetween(a, new Date('2026-10-07T14:00:00Z')), 0)
})
