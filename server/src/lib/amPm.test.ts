import test from 'node:test'
import assert from 'node:assert/strict'
import { localHour, oddStartHour, suspectAmPm } from './amPm.js'

const LA = 'America/Los_Angeles'

test('local hour is the hour on the wall', () => {
  // 6:19 PM Pacific on Nov 10 is 02:19 UTC on Nov 11.
  assert.equal(localHour(new Date('2026-11-11T02:19:00Z'), LA), 18)
  assert.equal(localHour(new Date('2026-11-10T14:19:00Z'), LA), 6)
  assert.equal(localHour(new Date('2026-11-10T08:00:00Z'), LA), 0)
})

test('5 PM to 4 AM counts as an odd start', () => {
  assert.equal(oddStartHour(16), false)
  assert.equal(oddStartHour(17), true)
  assert.equal(oddStartHour(23), true)
  assert.equal(oddStartHour(0), true)
  assert.equal(oddStartHour(3), true)
  assert.equal(oddStartHour(4), false)
  assert.equal(oddStartHour(6), false)
})

test("Nate's day: a 6:19 PM start and 14.6 hours is a suspected slip", () => {
  assert.equal(suspectAmPm(new Date('2026-11-11T02:19:00Z'), 14.62, LA), true)
})

test('night work of a normal length is not flagged', () => {
  assert.equal(suspectAmPm(new Date('2026-11-11T02:19:00Z'), 8, LA), false)
})

test('a long day that started in the morning is a long day, not a slip', () => {
  assert.equal(suspectAmPm(new Date('2026-11-10T14:19:00Z'), 14.62, LA), false)
})
