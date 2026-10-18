// End-to-end check against a running server:  npm run smoke
// Signs in as the admin from .env, then walks sign-in, keys, jobs, a full day of
// punches for a throwaway person, a correction, the board, the report and the feed.
// It cleans up after itself: the test person and job are deactivated, the key revoked.
import 'dotenv/config'
import { createHmac, randomBytes } from 'node:crypto'

const base = process.env.SMOKE_URL ?? `http://localhost:${process.env.PORT ?? 5400}`
const api = `${base}/api/v1`
const email = (process.env.ADMIN_EMAIL ?? '').toLowerCase()
const password = process.env.ADMIN_PASSWORD ?? ''

let failed = 0
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !extra ? '' : `  -> ${extra}`}`)
  if (!ok) failed += 1
}

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(api + path, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* not json */
  }
  return { status: res.status, json, headers: res.headers }
}

const stamp = Date.now().toString(36)
const testEmail = `smoke-${stamp}@example.invalid`
const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString()

try {
  let r = await call('GET', '/health')
  check('health', r.status === 200 && r.json?.ok === true, JSON.stringify(r.json))

  r = await call('GET', '/me/state')
  check('anonymous call is refused with 401', r.status === 401 && r.json?.error?.code === 'unauthorized')

  r = await call('POST', '/auth/login', { body: { email, password: 'definitely-wrong-password' } })
  check('wrong password is refused', r.status === 401)

  r = await call('POST', '/auth/login', { body: { email, password } })
  check('admin signs in', r.status === 200 && Boolean(r.json?.token), JSON.stringify(r.json))
  const admin = r.json?.token
  if (!admin) throw new Error('Cannot continue without signing in. Check ADMIN_EMAIL / ADMIN_PASSWORD in .env and that `npm run seed` has run.')

  r = await call('GET', '/phases', { token: admin })
  const allPhases = r.json?.data ?? []
  // The walk below steps through the field day; office phases are not steps in it.
  const phases = allPhases.filter((p) => p.dayFlow !== false)
  check('phases are seeded', phases.length >= 2, `got ${phases.length}`)
  r = await call('GET', '/phases?all=true', { token: admin })
  check('an admin sees every phase, switched off or not', r.status === 200 && (r.json?.data?.length ?? 0) >= allPhases.length)
  r = await call('PATCH', `/phases/${phases[0].id}`, { token: admin, body: { short: phases[0].short } })
  check('an admin can change a phase', r.status === 200 && r.json?.phase?.short === phases[0].short, JSON.stringify(r.json))
  r = await call('POST', '/phases', { token: admin, body: { name: 'Smoke never created', laborCategory: 'nonsense' } })
  check('a phase with an unknown labor category is refused', r.status === 400)
  check(
    'every phase names its labor category',
    allPhases.every((p) => typeof p.laborCategory === 'string' && p.laborCategory !== '' && typeof p.dayFlow === 'boolean'),
    JSON.stringify(allPhases.map((p) => [p.key, p.laborCategory, p.dayFlow])),
  )

  r = await call('POST', '/api-keys', { token: admin, body: { name: `smoke ${stamp}`, scopes: ['punch:read', 'punch:write:any', 'jobs:read', 'jobs:write', 'people:read', 'people:write', 'reports:read', 'events:read', 'assignments:write'] } })
  check('create integration key', r.status === 201 && r.json?.key?.startsWith('tt_live_'), JSON.stringify(r.json))
  const key = r.json?.key
  const keyId = r.json?.apiKey?.id

  r = await call('GET', '/api-keys', { token: key })
  check('a key cannot manage keys', r.status === 403)

  r = await call('PUT', `/jobs/by-ref/smoke/${stamp}`, { token: key, body: { name: `Smoke test job ${stamp}`, kind: 'project', code: `SMK-${stamp}` } })
  check('create job by external reference', r.status === 200 && r.json?.created === true, JSON.stringify(r.json))
  const jobId = r.json?.job?.id
  r = await call('PUT', `/jobs/by-ref/smoke/${stamp}`, { token: key, body: { code: `SMK2-${stamp}` } })
  check('repeat updates the same job', r.status === 200 && r.json?.created === false && r.json?.job?.id === jobId && r.json?.job?.code === `SMK2-${stamp}`)
  r = await call('PUT', `/jobs/by-ref/smoke/${stamp}`, { token: key, body: { siteAddress: '6621 220th St SW, Mountlake Terrace, WA 98043' } })
  check('a job keeps its site address', r.status === 200 && r.json?.job?.siteAddress === '6621 220th St SW, Mountlake Terrace, WA 98043', JSON.stringify(r.json?.job ?? r.json))

  r = await call('PUT', `/people/by-email/${encodeURIComponent(testEmail)}`, { token: key, body: { name: 'Smoke Test', initials: 'ZZ' } })
  check('create person by email', r.status === 200 && r.json?.created === true, JSON.stringify(r.json))
  r = await call('PUT', `/people/by-email/${encodeURIComponent(testEmail)}`, { token: key, body: { role: 'admin' } })
  check('a key cannot make an admin', r.status === 403)

  const as = { 'X-Act-As': testEmail }
  r = await call('POST', '/punches/in', { token: key, body: { jobId } })
  check('key without X-Act-As gets a clear error', r.status === 400 && r.json?.error?.code === 'no_person', JSON.stringify(r.json))

  r = await call('POST', '/punches/out', { token: key, headers: as })
  check('clock out while off the clock is a 409', r.status === 409 && r.json?.error?.code === 'not_clocked_in')

  r = await call('POST', '/punches/in', { token: key, headers: as, body: { jobRef: { system: 'smoke', externalId: stamp }, at: minutesAgo(50), clientId: `c1-${stamp}`, geo: { lat: 47.82, lng: -122.3, accuracyM: 12 } } })
  check('clock in by job reference, back-dated', r.status === 200 && r.json?.state?.onClock === true && r.json?.punch?.phase?.key === phases[0]?.key, JSON.stringify(r.json?.error ?? ''))
  const firstId = r.json?.punch?.id

  r = await call('POST', '/punches/in', { token: key, headers: as, body: { jobId, at: minutesAgo(50), clientId: `c1-${stamp}` } })
  check('re-sending the same clientId does nothing', r.status === 200 && r.json?.duplicate === true && r.json?.punch?.id === firstId)

  r = await call('POST', '/punches/next', { token: key, headers: { ...as, 'Idempotency-Key': `n1-${stamp}` }, body: { at: minutesAgo(40) } })
  check('next phase', r.status === 200 && r.json?.punch?.phase?.key === phases[1]?.key && r.json?.switchedFrom?.id === firstId, JSON.stringify(r.json?.error ?? ''))
  const secondId = r.json?.punch?.id
  r = await call('POST', '/punches/next', { token: key, headers: { ...as, 'Idempotency-Key': `n1-${stamp}` }, body: { at: minutesAgo(40) } })
  check('repeated Idempotency-Key replays the first answer', r.status === 200 && r.json?.punch?.id === secondId && r.headers.get('idempotent-replay') === 'true')

  r = await call('POST', '/punches/in', { token: key, headers: as, body: { jobId, at: minutesAgo(45) } })
  check('a punch before the open segment is refused', r.status === 409 && r.json?.error?.code === 'punch_overlap')

  r = await call('POST', '/punches/in', { token: key, headers: as, body: { jobId, at: new Date(Date.now() + 3_600_000).toISOString() } })
  check('a punch in the future is refused', r.status === 400)

  r = await call('GET', '/board', { token: key })
  const row = r.json?.rows?.find((x) => x.email === testEmail)
  check('board shows the person on the clock', r.status === 200 && row?.onClock === true && row?.phaseIndex === 1, JSON.stringify(row))

  r = await call('POST', '/punches/out', { token: key, headers: as, body: { at: minutesAgo(10) } })
  check('clock out', r.status === 200 && r.json?.state?.onClock === false && Math.abs(r.json?.state?.hoursToday - 40 / 60) < 0.01, `hoursToday=${r.json?.state?.hoursToday}`)
  check('the day remembers the last job for next time', r.json?.state?.lastJob?.id === jobId, JSON.stringify(r.json?.state?.lastJob ?? null))

  r = await call('PATCH', `/punches/${secondId}`, { token: key, body: { clockOut: minutesAgo(5) } })
  check('a correction without a reason is refused', r.status === 400)
  r = await call('PATCH', `/punches/${secondId}`, { token: key, body: { clockOut: minutesAgo(5), reason: 'smoke test correction' } })
  check('correct a segment', r.status === 200, JSON.stringify(r.json?.error ?? ''))
  r = await call('PATCH', `/punches/${secondId}`, { token: key, body: { clockIn: minutesAgo(48), reason: 'should overlap' } })
  check('a correction that overlaps is refused', r.status === 409 && r.json?.error?.code === 'punch_overlap')
  r = await call('GET', `/punches/${secondId}`, { token: key })
  check('the correction is in the history', r.json?.punch?.edits?.length === 1 && r.json.punch.edits[0].reason === 'smoke test correction')

  r = await call('GET', `/reports/hours?groupBy=job,phase&jobId=${jobId}`, { token: key })
  check('hours report', r.status === 200 && r.json?.rows?.length === 2 && Math.abs(r.json?.totalHours - 45 / 60) < 0.02, JSON.stringify(r.json))
  r = await call('GET', `/reports/hours?groupBy=laborCategory&jobId=${jobId}`, { token: key })
  check(
    'field-day hours roll up to install',
    r.status === 200 && r.json?.rows?.length === 1 && r.json.rows[0].laborCategory === 'install' && Math.abs(r.json.rows[0].hours - 45 / 60) < 0.02,
    JSON.stringify(r.json),
  )

  // The day's schedule pushed in by another app pre-selects the job.
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
  r = await call('PUT', `/assignments/${today}`, { token: key, body: { source: `smoke-${stamp}`, assignments: [
    { email: testEmail, jobRef: { system: 'smoke', externalId: stamp }, title: `ZZ to Smoke test job ${stamp} 7am shop`, shopTime: '7am', externalId: `evt-${stamp}` },
    { email: `nobody-${stamp}@example.invalid`, title: 'unknown person' },
  ] } })
  check('push the day\'s schedule', r.status === 200 && r.json?.saved === 1 && r.json?.withJob === 1 && r.json?.skipped?.length === 1, JSON.stringify(r.json))
  r = await call('GET', '/me/state', { token: key, headers: as })
  check('the person\'s day lists the scheduled job', r.json?.assignments?.length === 1 && r.json.assignments[0].job?.id === jobId && r.json.assignments[0].shopTime === '7am', JSON.stringify(r.json?.assignments))
  r = await call('PUT', `/assignments/${today}`, { token: key, body: { source: `smoke-${stamp}`, assignments: [] } })
  const after = await call('GET', '/me/state', { token: key, headers: as })
  check('a new push replaces the day', r.status === 200 && after.json?.assignments?.length === 0)
  r = await call('PUT', '/assignments/10-07-2026', { token: key, body: { assignments: [] } })
  check('a bad date is refused', r.status === 400)

  // Five punches at the same instant must still leave exactly one open segment.
  const burst = await Promise.all([1, 2, 3, 4, 5].map((n) => call('POST', '/punches/in', { token: key, headers: as, body: { jobId, clientId: `b${n}-${stamp}` } })))
  r = await call('GET', `/punches?open=true&personId=${row?.personId}`, { token: key })
  check('simultaneous punches leave one open segment', burst.every((x) => x.status === 200) && r.json?.data?.length === 1, `statuses=${burst.map((x) => x.status)} open=${r.json?.data?.length}`)
  r = await call('POST', '/punches/out', { token: key, headers: as })
  check('clock out after the burst', r.status === 200 && r.json?.state?.onClock === false)

  // A tech sees and changes only their own time.
  const techPw = `pw-${randomBytes(9).toString('base64url')}`
  r = await call('PUT', `/people/by-email/${encodeURIComponent(testEmail)}`, { token: key, body: { password: techPw } })
  check('a key cannot set a password', r.status === 403)
  r = await call('PUT', `/people/by-email/${encodeURIComponent(testEmail)}`, { token: admin, body: { password: techPw } })
  check('an admin sets a password', r.status === 200)
  r = await call('POST', '/auth/login', { body: { email: testEmail, password: techPw } })
  const tech = r.json?.token
  check('the tech signs in', r.status === 200 && r.json?.person?.role === 'tech')
  r = await call('GET', '/board', { token: tech })
  check('a tech cannot open the board', r.status === 403)
  r = await call('GET', '/people', { token: tech })
  check('a tech cannot list people', r.status === 403)
  r = await call('GET', '/punches?personId=someone-else', { token: tech })
  check('a tech lists only their own punches', r.status === 200 && r.json?.data?.length > 0 && r.json.data.every((p) => p.personId === row?.personId))
  r = await call('PATCH', `/punches/${secondId}`, { token: tech, body: { notes: 'x', reason: 'x' } })
  check('a tech cannot edit punches', r.status === 403)
  r = await call('GET', '/me/state', { token: tech })
  check(
    'the day says whether the Timesheets.com parallel run is on',
    r.status === 200 && 'parallelRun' in (r.json ?? {}) && (r.json.parallelRun === null || /^\d{4}-\d{2}-\d{2}$/.test(r.json.parallelRun.until)),
    JSON.stringify(r.json?.parallelRun),
  )
  check('a tech sees their own day', r.status === 200 && r.json?.today?.length >= 2 && r.json?.phases?.length === allPhases.length, `phases=${r.json?.phases?.length} expected=${allPhases.length}`)

  // Weekly timesheets: sign, approve, the lock, reopen. A second throwaway person
  // works one long day a week ago, so that week is over and can be approved.
  const adminMe = await call('GET', '/auth/me', { token: admin })
  const adminId = adminMe.json?.person?.id
  const crewEmail = `smoke-${stamp}-b@example.invalid`
  r = await call('PUT', `/people/by-email/${encodeURIComponent(crewEmail)}`, { token: key, body: { name: 'Smoke Crew', initials: 'ZY' } })
  const crewId = r.json?.person?.id
  const asB = { 'X-Act-As': crewEmail }
  const tz = 'America/Los_Angeles'
  const ymd = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const t0 = new Date(Date.now() - 7 * 86_400_000 - 14 * 3_600_000)
  const lastWeek = ymd(t0)
  r = await call('POST', '/punches/in', { token: key, headers: asB, body: { jobId, at: t0.toISOString() } })
  const oldId = r.json?.punch?.id
  r = await call('POST', '/punches/out', { token: key, headers: asB, body: { at: new Date(t0.getTime() + 13 * 3_600_000).toISOString() } })
  check('a back-dated day last week is recorded', r.status === 200 && Boolean(oldId), JSON.stringify(r.json?.error ?? ''))

  r = await call('GET', `/timesheets?week=${lastWeek}`, { token: admin })
  const sheetRow = r.json?.rows?.find((x) => x.person.id === crewId)
  check('the week view lists the person, hours and the long day', r.status === 200 && Math.abs((sheetRow?.hours ?? 0) - 13) < 0.02 && sheetRow?.status === 'open' && sheetRow?.problems >= 1, JSON.stringify(sheetRow ?? r.json))
  r = await call('GET', `/reports/exceptions?from=${lastWeek}&to=${lastWeek}&personId=${crewId}`, { token: key })
  check('exceptions report flags the 13-hour day', r.status === 200 && r.json?.data?.some((x) => x.code === 'long_day'), JSON.stringify(r.json))

  r = await call('POST', '/me/week/sign', { token: tech, body: {} })
  check('a tech signs their week', r.status === 200 && r.json?.status === 'signed', JSON.stringify(r.json))
  r = await call('POST', '/punches/in', { token: key, headers: as, body: { jobId } })
  r = await call('GET', `/timesheets/${row?.personId}`, { token: admin })
  check('a punch after signing sends the week back for signing', r.status === 200 && r.json?.status === 'open' && /after signing/.test(r.json?.note ?? ''), JSON.stringify({ status: r.json?.status, note: r.json?.note }))
  r = await call('POST', '/me/week/sign', { token: tech, body: {} })
  check('signing while on the clock is refused', r.status === 409 && r.json?.error?.code === 'open_segment')
  await call('POST', '/punches/out', { token: key, headers: as })

  r = await call('POST', '/timesheets/approve', { token: tech, body: { personIds: [crewId], week: lastWeek } })
  check('a tech cannot approve', r.status === 403)
  r = await call('GET', '/timesheets', { token: tech })
  check('a tech cannot see everyone\'s week', r.status === 403)
  r = await call('POST', '/timesheets/approve', { token: admin, body: { personIds: [row?.personId] } })
  check('a week that is not over cannot be approved', r.status === 409 && r.json?.error?.code === 'week_not_over')
  r = await call('POST', '/timesheets/approve', { token: admin, body: { personIds: [crewId], week: lastWeek } })
  check('approve last week', r.status === 200 && r.json?.approved === 1, JSON.stringify(r.json))
  r = await call('PATCH', `/punches/${oldId}`, { token: key, body: { notes: 'after approval', reason: 'smoke' } })
  check('an approved week refuses corrections', r.status === 409 && r.json?.error?.code === 'week_approved', JSON.stringify(r.json))
  r = await call('POST', '/punches/in', { token: key, headers: asB, body: { jobId, at: new Date(t0.getTime() + 13.5 * 3_600_000).toISOString() } })
  check('an approved week refuses late punches', r.status === 409 && r.json?.error?.code === 'week_approved', JSON.stringify(r.json))
  r = await call('POST', '/timesheets/reopen', { token: admin, body: { personId: crewId, week: lastWeek } })
  check('reopening needs a reason', r.status === 400)
  r = await call('POST', '/timesheets/reopen', { token: admin, body: { personId: crewId, week: lastWeek, reason: 'smoke reopen' } })
  check('reopen the week', r.status === 200 && r.json?.status === 'open', JSON.stringify(r.json?.error ?? r.json?.status))
  r = await call('PATCH', `/punches/${oldId}`, { token: key, body: { notes: 'after reopen', reason: 'smoke' } })
  check('a reopened week takes corrections again', r.status === 200, JSON.stringify(r.json?.error ?? ''))

  // Change requests: a person asks for their own time to be fixed, a supervisor decides.
  const H = 3_600_000
  r = await call('POST', '/me/requests', { token: key, headers: asB, body: { punchId: oldId, notes: 'forgot a note' } })
  check('a change request needs a reason', r.status === 400)
  r = await call('POST', '/me/requests', { token: key, headers: asB, body: { punchId: oldId, clockOut: new Date(t0.getTime() + 12 * H).toISOString(), reason: 'left at noon' } })
  const reqId = r.json?.request?.id
  check('ask for a change to your own time', r.status === 201 && r.json?.request?.status === 'pending', JSON.stringify(r.json))
  r = await call('POST', '/me/requests', { token: key, headers: asB, body: { punchId: oldId, notes: 'x', reason: 'again' } })
  check('one waiting request per segment', r.status === 409 && r.json?.error?.code === 'request_pending')
  r = await call('POST', '/me/requests', { token: tech, body: { punchId: oldId, notes: 'x', reason: 'not mine' } })
  check("nobody can ask to change someone else's time", r.status === 403)
  r = await call('POST', '/timesheets/approve', { token: admin, body: { personIds: [crewId], week: lastWeek } })
  check('a waiting request holds up approving the week', r.status === 200 && r.json?.results?.[0]?.code === 'pending_request', JSON.stringify(r.json))
  r = await call('POST', `/requests/${reqId}/approve`, { token: tech, body: {} })
  check('a tech cannot approve a change request', r.status === 403)
  r = await call('GET', '/requests?status=pending', { token: admin })
  check('supervisors see waiting requests', r.status === 200 && r.json?.data?.some((x) => x.id === reqId))
  r = await call('POST', `/requests/${reqId}/approve`, { token: admin, body: {} })
  check('approve the change', r.status === 200 && r.json?.request?.status === 'approved', JSON.stringify(r.json))
  r = await call('GET', `/punches/${oldId}`, { token: key })
  const lastEdit = r.json?.punch?.edits?.at(-1)
  check(
    'the approved change is applied and kept in the history',
    Math.abs(new Date(r.json?.punch?.clockOut).getTime() - (t0.getTime() + 12 * H)) < 1000 && /asked by Smoke Crew, approved by/.test(lastEdit?.reason ?? ''),
    JSON.stringify(lastEdit ?? r.json),
  )
  r = await call('POST', `/requests/${reqId}/reject`, { token: admin, body: { note: 'x' } })
  check('a decided request cannot be decided again', r.status === 409)

  const gap = { clockIn: new Date(t0.getTime() + 12.5 * H).toISOString(), clockOut: new Date(t0.getTime() + 13.5 * H).toISOString(), jobId }
  r = await call('POST', '/me/requests', { token: key, headers: asB, body: { ...gap, reason: 'forgot to clock back in' } })
  const addId = r.json?.request?.id
  check('ask for missing time', r.status === 201 && r.json?.request?.kind === 'add', JSON.stringify(r.json))
  r = await call('POST', `/requests/${addId}/reject`, { token: admin, body: {} })
  check('turning a request down needs a note', r.status === 400)
  r = await call('POST', `/requests/${addId}/reject`, { token: admin, body: { note: 'smoke: no' } })
  check('turn a request down', r.status === 200 && r.json?.request?.status === 'rejected')
  r = await call('POST', '/me/requests', { token: key, headers: asB, body: { ...gap, reason: 'forgot, again' } })
  r = await call('POST', `/me/requests/${r.json?.request?.id}/withdraw`, { token: key, headers: asB })
  check('withdraw a request', r.status === 200 && r.json?.request?.status === 'withdrawn', JSON.stringify(r.json))
  r = await call('POST', '/me/requests', { token: key, headers: asB, body: { ...gap, reason: 'third time' } })
  r = await call('POST', `/requests/${r.json?.request?.id}/approve`, { token: admin, body: { note: 'ok' } })
  check('approve missing time', r.status === 200 && r.json?.request?.status === 'approved', JSON.stringify(r.json))
  r = await call('GET', `/timesheets/${crewId}?week=${lastWeek}`, { token: admin })
  check('the week adds up after the changes', Math.abs((r.json?.hours ?? 0) - 13) < 0.02 && r.json?.requests?.length === 4, `hours=${r.json?.hours} requests=${r.json?.requests?.length}`)

  // Crew punch: a lead clocks several people at once; one bad id does not stop the rest.
  r = await call('POST', '/crew/in', { token: admin, body: { personIds: [row?.personId, crewId, 'no-such-person'], jobId, phaseKey: phases[0].key, clientId: `crew-${stamp}` } })
  check('crew clock-in', r.status === 200 && r.json?.punched === 2 && r.json?.results?.find((x) => x.personId === 'no-such-person')?.ok === false, JSON.stringify(r.json))
  r = await call('POST', '/crew/in', { token: admin, body: { personIds: [row?.personId, crewId], jobId, phaseKey: phases[0].key, clientId: `crew-${stamp}` } })
  const r2 = await call('GET', `/punches?open=true&personId=${crewId}`, { token: key })
  check('re-sending a crew punch does nothing twice', r.status === 200 && r2.json?.data?.length === 1 && r2.json.data[0].punchedById === adminId, JSON.stringify(r2.json?.data?.[0] ?? null))
  r = await call('POST', '/crew/next', { token: admin, body: { personIds: [row?.personId, crewId], phaseKey: phases[1].key } })
  check('crew moves to the next phase together', r.status === 200 && r.json?.punched === 2, JSON.stringify(r.json))
  r = await call('POST', '/crew/out', { token: admin, body: { personIds: [row?.personId, crewId] } })
  check('crew clock-out', r.status === 200 && r.json?.punched === 2 && r.json.results.every((x) => x.onClock === false), JSON.stringify(r.json))
  r = await call('POST', '/crew/out', { token: tech, body: { personIds: [crewId] } })
  check('a tech cannot punch a crew', r.status === 403)

  // One-click sign-in from GED, when the shared secret is configured.
  const sso = process.env.ADDON_SSO_SECRET
  if (sso) {
    const sign = (payload) => {
      const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
      return `v1.${body}.${createHmac('sha256', sso).update(`v1.${body}`).digest('base64url')}`
    }
    const nowSec = Math.floor(Date.now() / 1000)
    const good = sign({ v: 1, aud: 'time_tracking', email: testEmail, name: 'Smoke Test', iat: nowSec, exp: nowSec + 60, jti: `j-${stamp}` })
    r = await call('POST', '/auth/sso', { body: { token: good } })
    check('one-click sign-in works', r.status === 200 && r.json?.person?.email === testEmail, JSON.stringify(r.json?.error ?? ''))
    r = await call('POST', '/auth/sso', { body: { token: good } })
    check('the same sign-in link cannot be used twice', r.status === 401)
    r = await call('POST', '/auth/sso', { body: { token: sign({ v: 1, aud: 'av_inventory', email: testEmail, iat: nowSec, exp: nowSec + 60, jti: `k-${stamp}` }) } })
    check('a link meant for another app is refused', r.status === 401)
    r = await call('POST', '/auth/sso', { body: { token: good.slice(0, -3) + 'abc' } })
    check('a tampered link is refused', r.status === 401)
  } else {
    console.log('SKIP  one-click sign-in (ADDON_SSO_SECRET is not set)')
  }

  // Read the whole feed (it grows with every run) and keep this run's events.
  const feed = []
  for (let after = 0, page = 0; page < 200; page++) {
    r = await call('GET', `/events?after=${after}&limit=500`, { token: key })
    feed.push(...(r.json?.data ?? []))
    if (!r.json?.more) break
    after = r.json.lastSeq
  }
  const types = new Set(feed.map((e) => e.type))
  check('change feed has the events', ['job.upserted', 'person.upserted', 'punch.started', 'punch.switched', 'punch.ended', 'punch.edited'].every((t) => types.has(t)), [...types].join(','))
  const ourStarts = feed.filter((e) => e.type === 'punch.started' && e.payload?.punch?.jobId === jobId)
  check('punch events carry the job code (GED reads P-numbers from it)', ourStarts.length > 0 && ourStarts.every((e) => e.payload.punch.jobCode === `SMK2-${stamp}`), JSON.stringify(ourStarts[0]?.payload ?? null))

  r = await call('GET', '/openapi.json')
  check('API describes itself', r.status === 200 && Boolean(r.json?.paths?.['/punches/in']?.post))

  // Clean up.
  await call('PUT', `/people/by-email/${encodeURIComponent(testEmail)}`, { token: key, body: { active: false } })
  await call('PUT', `/people/by-email/${encodeURIComponent(crewEmail)}`, { token: key, body: { active: false } })
  await call('PUT', `/jobs/by-ref/smoke/${stamp}`, { token: key, body: { active: false } })
  r = await call('DELETE', `/api-keys/${keyId}`, { token: admin })
  check('revoke the key', r.status === 200 && Boolean(r.json?.apiKey?.revokedAt))
  r = await call('GET', '/board', { token: key })
  check('a revoked key stops working', r.status === 401)
  r = await call('GET', '/me/state', { token: tech })
  check('a deactivated person is signed out', r.status === 401)
} catch (err) {
  failed += 1
  console.log(`FAIL  ${err instanceof Error ? err.message : err}`)
}

console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.')
process.exit(failed ? 1 : 0)
