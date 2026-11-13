// Run with: npm test (node's own test runner; no test framework to install).
import test from 'node:test'
import assert from 'node:assert/strict'
import { checkTimes, oddStartHour } from './timeCheck.ts'

// The checker reads times on this machine's clock, as the browser does. Pin it to
// Lynnwood so the results do not depend on where the tests run.
process.env.TZ = 'America/Los_Angeles'

test('a normal day is left alone', () => {
  assert.equal(checkTimes('2026-11-10T06:30', '2026-11-10T15:00'), null)
  assert.equal(checkTimes('2026-11-10T07:00', ''), null)
  assert.equal(checkTimes('', ''), null)
})

test('5 PM to 4 AM is an odd start', () => {
  assert.deepEqual([16, 17, 23, 0, 3, 4].map(oddStartHour), [false, true, true, true, true, false])
})

test("Nate: clock-in 6:19 PM on a day that ends in the afternoon offers 6:19 AM", () => {
  const w = checkTimes('2026-11-10T18:19', '2026-11-10T15:30')
  assert.ok(w)
  assert.equal(w.title, 'Clock-in at 6:19 PM?')
  assert.equal(w.question, 'Did you mean 6:19 AM?')
  assert.equal(w.fix?.label, 'Switch to 6:19 AM')
  assert.equal(w.fix?.clockIn, '2026-11-10T06:19')
  assert.equal(w.fix?.clockOut, '2026-11-10T15:30')
})

test('a start saved on the evening before, making a 14-hour day, moves to that morning', () => {
  // 6:19 PM Mon to 8:56 AM Tue is 14.6 hours; 6:19 AM Tue gives a normal shift.
  const w = checkTimes('2026-11-09T18:19', '2026-11-10T08:56')
  assert.ok(w)
  assert.ok(w.lines.some((l) => l.includes('14.6 hour')))
  assert.equal(w.fix?.clockIn, '2026-11-10T06:19')
})

test('a 6:19 PM start with no end yet still asks', () => {
  const w = checkTimes('2026-11-10T18:19', '')
  assert.equal(w?.fix?.clockIn, '2026-11-10T06:19')
  assert.equal(w?.fix?.clockOut, '')
})

test('clock-out at 3:30 AM after a 7 AM start offers 3:30 PM', () => {
  const w = checkTimes('2026-11-10T07:00', '2026-11-10T03:30')
  assert.ok(w)
  assert.equal(w.title, 'Clock-out at 3:30 AM?')
  assert.equal(w.fix?.clockOut, '2026-11-10T15:30')
  assert.equal(w.fix?.clockIn, '2026-11-10T07:00')
})

test('a 13-hour morning day asks, but offers no switch that would make a 1-hour day', () => {
  const w = checkTimes('2026-11-10T06:00', '2026-11-10T19:00')
  assert.ok(w)
  assert.equal(w.title, 'Check these times')
  assert.equal(w.fix, undefined)
  assert.ok(w.lines.some((l) => l.includes('13.0 hour')))
})

test('a night shift that ends on the same date offers the next morning', () => {
  const w = checkTimes('2026-11-10T22:00', '2026-11-10T06:00')
  assert.ok(w)
  assert.equal(w.fix?.clockOut, '2026-11-11T06:00')
})

test('real night work of a normal length still asks once, with nothing to switch', () => {
  // 6 PM to 2 AM: flipping either time makes it worse, so only Keep or Go back.
  const w = checkTimes('2026-11-10T18:00', '2026-11-11T02:00')
  assert.ok(w)
  assert.equal(w.title, 'Check these times')
  assert.equal(w.fix, undefined)
})
