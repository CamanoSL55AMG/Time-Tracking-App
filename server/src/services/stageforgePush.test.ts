import { test } from 'node:test'
import assert from 'node:assert/strict'
import { payloadHash, planPush, timeActivityFor, type PushPunch } from './stageforgePush.js'

const TZ = 'America/Los_Angeles'
const punch = (o: Partial<PushPunch> = {}): PushPunch => ({
  id: 'punch-1',
  // Monday Nov 2, 2026, 7:00 to 15:30 Pacific
  clockIn: new Date('2026-11-02T15:00:00Z'),
  clockOut: new Date('2026-11-02T23:30:00Z'),
  notes: '',
  updatedAt: new Date('2026-11-02T23:30:00Z'),
  person: { id: 'p1', name: 'Jake Tech', email: 'Jake@MorganSound.com', workerType: 'employee', workerTypeFrom: null, priorWorkerType: null },
  job: { code: 'SHOP', name: 'Shop', kind: 'shop' },
  phase: { key: 'prep', name: 'Prep', laborCategory: 'other' },
  ...o,
})

test('a finished segment becomes a time activity with Logbook\'s id on it', () => {
  const ta = timeActivityFor(punch(), TZ) as Record<string, any>
  assert.equal(ta.TxnDate, '2026-11-02')
  assert.equal(ta.Hours, 8)
  assert.equal(ta.Minutes, 30)
  assert.equal(ta.Description, 'SHOP Shop / Prep')
  assert.equal(ta.StageForge.externalId, 'punch-1')
  assert.equal(ta.StageForge.email, 'jake@morgansound.com')
  assert.equal(ta.StageForge.workerType, 'w2')
  assert.equal(ta.StageForge.payable, false)
})

test('the day is the company day the segment started, not the UTC day', () => {
  // 17:00 to 19:00 Pacific on Nov 2 is Nov 3 in UTC.
  const ta = timeActivityFor(punch({ clockIn: new Date('2026-11-03T01:00:00Z'), clockOut: new Date('2026-11-03T03:00:00Z') }), TZ)
  assert.equal(ta.TxnDate, '2026-11-02')
})

test('a contractor is marked as one', () => {
  const ta = timeActivityFor(punch({ person: { ...punch().person, workerType: 'contractor' } }), TZ) as Record<string, any>
  assert.equal(ta.StageForge.workerType, 'contractor')
})

test('an open segment is never sent', () => {
  assert.throws(() => timeActivityFor(punch({ clockOut: null }), TZ))
})

test('only new, changed or failed segments are sent again', () => {
  const a = payloadHash(timeActivityFor(punch(), TZ))
  const b = payloadHash(timeActivityFor(punch({ clockOut: new Date('2026-11-02T23:45:00Z') }), TZ))
  assert.notEqual(a, b)
  const sent = new Map([
    ['same', { payloadHash: a, status: 'sent' }],
    ['changed', { payloadHash: a, status: 'sent' }],
    ['failed', { payloadHash: a, status: 'failed' }],
  ])
  const plan = planPush(
    [{ punchId: 'same', hash: a }, { punchId: 'changed', hash: b }, { punchId: 'failed', hash: a }, { punchId: 'new', hash: a }],
    sent,
  )
  assert.deepEqual(plan, { send: ['changed', 'failed', 'new'], unchanged: 1 })
})
