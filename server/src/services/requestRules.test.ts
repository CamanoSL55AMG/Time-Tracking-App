import { test } from 'node:test'
import assert from 'node:assert/strict'
import { earliestRequestDate, payPeriodStart, planTimesChange, requestWindowProblem, type Span } from './requestRules.js'

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

// ─── Fixing your own time ───────────────────────────────────────────────────

test('the pay period starts on the 1st or the 16th', () => {
  assert.equal(payPeriodStart('2026-11-01'), '2026-11-01')
  assert.equal(payPeriodStart('2026-11-15'), '2026-11-01')
  assert.equal(payPeriodStart('2026-11-16'), '2026-11-16')
  assert.equal(payPeriodStart('2026-11-30'), '2026-11-16')
  assert.equal(payPeriodStart('2026-02-28'), '2026-02-16')
})

// A field day on Nov 9 (Pacific): drive 7:00-7:30, pull wire 7:30-12:00, lunch off,
// terminate 12:30-15:30. Times in UTC (PST = UTC-8).
const at = (hhmm: string) => new Date(`2026-11-09T${String(Number(hhmm.slice(0, 2)) + 8).padStart(2, '0')}:${hhmm.slice(3)}:00Z`)
const day: Span[] = [
  { id: 'drive', clockIn: at('07:00'), clockOut: at('07:30') },
  { id: 'wire', clockIn: at('07:30'), clockOut: at('12:00') },
  { id: 'term', clockIn: at('12:30'), clockOut: at('15:30') },
]
const ok = (r: ReturnType<typeof planTimesChange>) => {
  if ('problem' in r) assert.fail(`expected a plan, got ${JSON.stringify(r.problem)}`)
  return r
}
const by = (r: { updates: { id: string; clockIn: Date; clockOut: Date | null }[] }, id: string) => r.updates.find((u) => u.id === id)

test('moving a switch moves both sides of it', () => {
  // Really got to the site at 7:45: the drive ends and the wire pull starts at 7:45.
  const r = ok(planTimesChange(day, 'wire', { clockIn: at('07:45') }))
  assert.equal(r.updates.length, 2)
  assert.deepEqual(by(r, 'drive')?.clockOut, at('07:45'))
  assert.deepEqual(by(r, 'wire')?.clockIn, at('07:45'))
  assert.equal(r.opensGap, false)
})

test('moving the end of a segment moves the start of the one it meets', () => {
  const r = ok(planTimesChange(day, 'drive', { clockOut: at('07:15') }))
  assert.deepEqual(by(r, 'wire')?.clockIn, at('07:15'))
  assert.deepEqual(by(r, 'wire')?.clockOut, at('12:00'))
})

test('an edge next to a break moves on its own', () => {
  // Back from lunch at 12:15 instead of 12:30: only the termination segment changes.
  const r = ok(planTimesChange(day, 'term', { clockIn: at('12:15') }))
  assert.equal(r.updates.length, 1)
  assert.deepEqual(by(r, 'term')?.clockIn, at('12:15'))
})

test('running into a segment it does not meet is refused, not fixed silently', () => {
  const r = planTimesChange(day, 'term', { clockIn: at('11:45') })
  assert.deepEqual('problem' in r && r.problem, { code: 'overlap', neighbourId: 'wire' })
})

test('a switch cannot be moved past the start of the segment before it', () => {
  const r = planTimesChange(day, 'wire', { clockIn: at('06:55') })
  assert.deepEqual('problem' in r && r.problem, { code: 'swallows', neighbourId: 'drive', side: 'before' })
  const r2 = planTimesChange(day, 'drive', { clockOut: at('12:00') })
  assert.deepEqual('problem' in r2 && r2.problem, { code: 'swallows', neighbourId: 'wire', side: 'after' })
})

test('unjoining a switch leaves a gap and says so', () => {
  // Took 15 minutes off between the drive and the wire pull.
  const r = ok(planTimesChange(day, 'drive', { clockOut: at('07:15') }, false))
  assert.equal(r.updates.length, 1)
  assert.equal(r.opensGap, true)
  const r2 = planTimesChange(day, 'drive', { clockOut: at('07:45') }, false)
  assert.deepEqual('problem' in r2 && r2.problem, { code: 'overlap', neighbourId: 'wire' })
})

test('the end must be after the start, and nothing to change is refused', () => {
  const backwards = planTimesChange(day, 'term', { clockOut: at('12:30') })
  assert.deepEqual('problem' in backwards && backwards.problem, { code: 'end_before_start' })
  const same = planTimesChange(day, 'term', { clockIn: at('12:30') })
  assert.deepEqual('problem' in same && same.problem, { code: 'nothing_to_change' })
  const missing = planTimesChange(day, 'nope', { clockIn: at('12:30') })
  assert.deepEqual('problem' in missing && missing.problem, { code: 'not_found' })
})

test('a missed clock-out can be closed, but not past 24 hours', () => {
  const open: Span[] = [...day.slice(0, 2), { id: 'term', clockIn: at('12:30'), clockOut: null }]
  const r = ok(planTimesChange(open, 'term', { clockOut: at('15:30') }))
  assert.deepEqual(by(r, 'term')?.clockOut, at('15:30'))
  const long = planTimesChange(open, 'term', { clockOut: new Date(at('12:30').getTime() + 25 * 3_600_000) })
  assert.deepEqual('problem' in long && long.problem, { code: 'too_long' })
})

test('stepping forward through the day: each fix builds on the one before', () => {
  // Start the day at 6:50, then move the lunch break to 11:45-12:15.
  let segs = day
  const apply = (r: { updates: { id: string; clockIn: Date; clockOut: Date | null }[] }) => {
    segs = segs.map((s) => {
      const u = r.updates.find((x) => x.id === s.id)
      return u ? { id: s.id, clockIn: u.clockIn, clockOut: u.clockOut } : s
    })
  }
  apply(ok(planTimesChange(segs, 'drive', { clockIn: at('06:50') })))
  apply(ok(planTimesChange(segs, 'wire', { clockOut: at('11:45') })))
  apply(ok(planTimesChange(segs, 'term', { clockIn: at('12:15') })))
  assert.deepEqual(
    segs.map((s) => [s.id, s.clockIn.toISOString(), s.clockOut?.toISOString()]),
    [
      ['drive', at('06:50').toISOString(), at('07:30').toISOString()],
      ['wire', at('07:30').toISOString(), at('11:45').toISOString()],
      ['term', at('12:15').toISOString(), at('15:30').toISOString()],
    ],
  )
})
