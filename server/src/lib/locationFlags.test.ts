import test from 'node:test'
import assert from 'node:assert/strict'
import { locationFlags, noLocationReason, type LocationPunch } from './locationFlags.js'

const t = (hhmm: string) => new Date(`2026-11-13T${hhmm}:00Z`)
const seg = (id: string, from: string, to: string | null, inS: string | null, outS: string | null, personId = 'p1'): LocationPunch => ({
  id,
  personId,
  clockIn: t(from),
  clockOut: to ? t(to) : null,
  inGeoStatus: inS,
  outGeoStatus: outS,
  source: 'app',
})

test('a declined clock-in and clock-out are both flagged as declined', () => {
  const f = locationFlags([seg('a', '15:00', '23:00', 'denied', 'denied')])
  assert.deepEqual(
    f.map((x) => [x.punchId, x.side, x.code]),
    [
      ['a', 'in', 'location_declined'],
      ['a', 'out', 'location_declined'],
    ],
  )
})

test('captured and unknown (old punches, edits, integrations) are not flagged', () => {
  assert.deepEqual(locationFlags([seg('a', '15:00', '16:00', 'captured', 'captured'), seg('b', '16:30', '17:00', null, null)]), [])
})

test('a switch is one tap: only the new segment start is flagged', () => {
  const f = locationFlags([seg('a', '15:00', '16:00', 'captured', 'denied'), seg('b', '16:00', null, 'denied', null)])
  assert.deepEqual(
    f.map((x) => [x.punchId, x.side]),
    [['b', 'in']],
  )
})

test('another person starting at the same minute does not hide a real clock-out', () => {
  const f = locationFlags([seg('a', '15:00', '16:00', 'captured', 'denied', 'p1'), seg('b', '16:00', null, 'captured', null, 'p2')])
  assert.deepEqual(
    f.map((x) => [x.punchId, x.side, x.code]),
    [['a', 'out', 'location_declined']],
  )
})

test('a timeout or no GPS is flagged as missing, not declined', () => {
  const f = locationFlags([seg('a', '15:00', '16:00', 'timeout', 'unavailable'), seg('b', '17:00', null, 'unsupported', null)])
  assert.deepEqual(
    f.map((x) => x.code),
    ['no_location', 'no_location', 'no_location'],
  )
})

test('reasons read plainly and name the lead when a lead punched', () => {
  assert.equal(noLocationReason('denied', false), 'location was declined on the phone')
  assert.equal(noLocationReason('denied', true), "location was declined on the crew lead's phone")
  assert.match(noLocationReason('timeout', false), /in time/)
})
