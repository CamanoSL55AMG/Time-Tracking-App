import test from 'node:test'
import assert from 'node:assert/strict'
import { isArchived, RECENT_DAYS } from './jobArchive.js'

const now = new Date('2026-11-09T20:00:00Z')
const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000)

test('won projects stay on top with no punches', () => {
  for (const stage of ['CONTRACT', 'install', ' Review ']) assert.equal(isArchived({ kind: 'project', active: true, stage }, now), false)
})

test('a proposal nobody punched on lately is archived', () => {
  assert.equal(isArchived({ kind: 'project', active: true, stage: 'PROPOSAL' }, now), true)
  assert.equal(isArchived({ kind: 'project', active: true, stage: 'PROPOSAL', lastPunchAt: daysAgo(RECENT_DAYS + 1) }, now), true)
})

test('recent punches keep any open project on top', () => {
  assert.equal(isArchived({ kind: 'project', active: true, stage: 'PROPOSAL', lastPunchAt: daysAgo(3) }, now), false)
  assert.equal(isArchived({ kind: 'project', active: true, stage: '', lastPunchAt: daysAgo(RECENT_DAYS) }, now), false)
  assert.equal(isArchived({ kind: 'project', active: true, lastPunchAt: daysAgo(10).toISOString() }, now), false)
})

test('closed jobs are always archived', () => {
  assert.equal(isArchived({ kind: 'project', active: false, stage: 'INSTALL', lastPunchAt: daysAgo(1) }, now), true)
  assert.equal(isArchived({ kind: 'service', active: false }, now), true)
})

test('open non-project jobs are never archived', () => {
  for (const kind of ['service', 'visit', 'shop', 'repair', 'other']) assert.equal(isArchived({ kind, active: true }, now), false)
})
