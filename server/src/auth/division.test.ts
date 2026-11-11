import test from 'node:test'
import assert from 'node:assert/strict'
import { divisionMayCall, isDivisionScoped, normalizeDivision, scopePersonFilter } from './division.js'
import { GUARDED_ROLES, isRole, KEYS_MANAGE, ROLE_SCOPES, SELF } from './apiKeys.js'
import { registry } from '../api.js'
import { ApiError } from '../errors.js'
// Load every router so the registry holds every endpoint.
import '../routes/assignments.js'
import '../routes/auth.js'
import '../routes/expenses.js'
import '../routes/items.js'
import '../routes/jobs.js'
import '../routes/leave.js'
import '../routes/payroll.js'
import '../routes/people.js'
import '../routes/punches.js'
import '../routes/system.js'
import '../routes/terms.js'
import '../routes/timesheets.js'

test('division names compare after trimming and folding spaces', () => {
  assert.equal(normalizeDivision('  Sound   Services '), 'Sound Services')
  assert.equal(normalizeDivision(undefined), '')
  assert.equal(normalizeDivision(42), '')
})

test('division_admin is a real role, guarded like admin', () => {
  assert.equal(isRole('division_admin'), true)
  assert.ok(GUARDED_ROLES.includes('division_admin'))
  assert.ok(GUARDED_ROLES.includes('admin'))
})

test('division admins get the admin screens, not payroll, keys, set-up or other people', () => {
  const s = new Set(ROLE_SCOPES.division_admin)
  for (const want of [SELF, 'punch:read', 'timesheets:approve', 'requests:approve', 'punch:write:any', 'reports:read', 'leave:read', 'leave:approve']) {
    assert.ok(s.has(want), `should have ${want}`)
  }
  // Payroll export stays with Art and payroll (open question 1, default no).
  for (const never of ['payroll:read', KEYS_MANAGE, 'leave:write', 'people:write', 'jobs:write', 'expenses:read', 'expenses:approve', 'events:read', 'assignments:write', 'punch:crew', 'people:roles']) {
    assert.equal(s.has(never), false, `should not have ${never}`)
  }
})

test('only a division admin session is division scoped', () => {
  assert.equal(isDivisionScoped(undefined), false)
  assert.equal(isDivisionScoped({ division: null }), false)
  assert.equal(isDivisionScoped({ division: 'Sound Services' }), true)
  // No division set yet: still limited, to nobody.
  assert.equal(isDivisionScoped({ division: '' }), true)
})

test('person filter: no limit for everyone else', () => {
  assert.equal(scopePersonFilter(null), undefined)
  assert.equal(scopePersonFilter(null, 'p9'), 'p9')
})

test('person filter: a division admin sees their division only', () => {
  assert.deepEqual(scopePersonFilter(['p1', 'p2']), { in: ['p1', 'p2'] })
  assert.equal(scopePersonFilter(['p1', 'p2'], 'p2'), 'p2')
  assert.deepEqual(scopePersonFilter([]), { in: [] })
  assert.throws(
    () => scopePersonFilter(['p1', 'p2'], 'p9'),
    (e: unknown) => e instanceof ApiError && e.status === 404,
  )
})

test('route gate: reviewed routes and the caller’s own routes only', () => {
  assert.equal(divisionMayCall({ access: 'public' }), true)
  assert.equal(divisionMayCall({ access: [] }), true)
  assert.equal(divisionMayCall({ access: [SELF] }), true)
  assert.equal(divisionMayCall({ access: [SELF, 'punch:read'] }), false)
  assert.equal(divisionMayCall({ access: ['punch:read'] }), false)
  assert.equal(divisionMayCall({ access: ['punch:read'], division: 'scoped' }), true)
})

// If this fails, a route a division admin can reach was added or changed. Limit it to
// the caller's division (auth/division.ts) and mark it division: 'scoped', or leave it
// refused and add it to the list below.
test('every route a division admin can reach is limited to their division or refused', () => {
  const mine = new Set(ROLE_SCOPES.division_admin)
  const refused = registry
    .filter((r) => r.access !== 'public' && (r.access.length === 0 || r.access.some((s) => mine.has(s))))
    .filter((r) => !divisionMayCall(r))
    .map((r) => `${r.method.toUpperCase()} ${r.path}`)
    .sort()
  assert.deepEqual(refused, ['GET /assignments/:date', 'GET /company/service-billing', 'GET /reports/service-billing'])
})

test('the division admin screens are all marked as limited to the division', () => {
  const scoped = new Set(registry.filter((r) => r.division === 'scoped').map((r) => `${r.method.toUpperCase()} ${r.path}`))
  for (const r of [
    'GET /timesheets',
    'GET /timesheets/:personId',
    'POST /timesheets/approve',
    'POST /timesheets/reopen',
    'GET /requests',
    'POST /requests/:id/approve',
    'POST /requests/:id/reject',
    'GET /edits',
    'POST /edits/reviewed',
    'GET /reports/exceptions',
    'GET /reports/hours',
    'GET /punches',
    'PATCH /punches/:id',
    'GET /board',
    'GET /people',
    'GET /leave/balances',
    'GET /leave/requests',
    'POST /leave/requests/:id/approve',
    'POST /leave/requests/:id/deny',
  ]) {
    assert.ok(scoped.has(r), `${r} should be division scoped`)
  }
  // Payroll is never open to a division admin.
  assert.equal([...scoped].some((r) => r.includes('/payroll')), false)
})
