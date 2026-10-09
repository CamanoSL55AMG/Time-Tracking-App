// End-to-end check against a running server:  npm run smoke
// Signs in as the admin from .env, then walks sign-in, keys, jobs, a full day of
// punches for a throwaway person, a correction, the board, the report, weekly
// sign-off and approval, crew punches, reconcile, a webhook delivery and the feed.
// It cleans up after itself: the test person and job are deactivated, the key revoked.
import 'dotenv/config'
import { createHmac, randomBytes } from 'node:crypto'
import { createServer } from 'node:http'

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
  const phases = r.json?.data ?? []
  check('phases are seeded', phases.length >= 2, `got ${phases.length}`)

  r = await call('POST', '/api-keys', { token: admin, body: { name: `smoke ${stamp}`, scopes: ['punch:read', 'punch:write:any', 'jobs:read', 'jobs:write', 'people:read', 'people:write', 'reports:read', 'events:read', 'assignments:write', 'time:approve', 'punch:crew', 'reconcile:write', 'webhooks:manage'] } })
  check('create integration key', r.status === 201 && r.json?.key?.startsWith('tt_live_'), JSON.stringify(r.json))
  const key = r.json?.key
  const keyId = r.json?.apiKey?.id

  r = await call('GET', '/api-keys', { token: key })
  check('a key cannot manage keys', r.status === 403)

  // Where the change feed stands now, so the events this run causes can be found later.
  let startSeq = 0
  for (;;) {
    r = await call('GET', `/events?after=${startSeq}&limit=500`, { token: key })
    startSeq = r.json?.lastSeq ?? startSeq
    if (!r.json?.more) break
  }

  r = await call('PUT', `/jobs/by-ref/smoke/${stamp}`, { token: key, body: { name: `Smoke test job ${stamp}`, kind: 'project', code: `SMK-${stamp}` } })
  check('create job by external reference', r.status === 200 && r.json?.created === true, JSON.stringify(r.json))
  const jobId = r.json?.job?.id
  r = await call('PUT', `/jobs/by-ref/smoke/${stamp}`, { token: key, body: { code: `SMK2-${stamp}` } })
  check('repeat updates the same job', r.status === 200 && r.json?.created === false && r.json?.job?.id === jobId && r.json?.job?.code === `SMK2-${stamp}`)

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
  check('a tech sees their own day', r.status === 200 && r.json?.today?.length >= 2 && r.json?.phases?.length === phases.length)

  // ─── Review: missed time, weekly sign-off and approval ──────────────────
  const personId = row?.personId
  r = await call('GET', '/company', { token: tech })
  check('anyone signed in can read the company settings', r.status === 200 && Number.isInteger(r.json?.company?.weekStartDay))
  const past = new Date(Date.now() - 28 * 86_400_000)
  const pastIn = past.toISOString()
  const pastOut = new Date(past.getTime() + 2 * 3_600_000).toISOString()
  const pastDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(past)
  r = await call('POST', '/punches', { token: key, body: { personId, jobId, clockIn: pastIn, clockOut: pastOut } })
  check('adding missed time without a reason is refused', r.status === 400)
  r = await call('POST', '/punches', { token: key, body: { personId, jobId, clockIn: pastIn, clockOut: pastOut, reason: 'smoke: forgot to punch' } })
  check('add a missed segment', r.status === 201 && r.json?.punch?.source === 'edit', JSON.stringify(r.json?.error ?? ''))
  const addedId = r.json?.punch?.id
  r = await call('POST', '/punches', { token: key, body: { personId, jobId, clockIn: pastIn, clockOut: pastOut, reason: 'twice' } })
  check('missed time that overlaps is refused', r.status === 409 && r.json?.error?.code === 'punch_overlap')

  r = await call('GET', `/me/week?week=${pastDay}`, { token: tech })
  check('the tech sees that week', r.status === 200 && Math.abs(r.json?.hours - 2) < 0.01 && r.json?.days?.length === 7, JSON.stringify(r.json?.error ?? r.json?.hours))
  const week = r.json?.week
  r = await call('POST', '/approvals/sign', { token: tech, body: { week } })
  check('the tech signs the week', r.status === 200 && Boolean(r.json?.approval?.signedAt), JSON.stringify(r.json?.error ?? ''))
  r = await call('POST', '/approvals/approve', { token: tech, body: { week, personIds: [personId] } })
  check('a tech cannot approve', r.status === 403)
  r = await call('GET', `/approvals?week=${week}`, { token: key })
  const mine = r.json?.rows?.find((x) => x.personId === personId)
  check('the week list shows the signature', r.status === 200 && Boolean(mine?.signedAt) && !mine?.approvedAt, JSON.stringify(mine))
  r = await call('POST', '/approvals/approve', { token: key, body: { week: today, personIds: [personId] } })
  check('a week that is not over cannot be approved', r.status === 409 && r.json?.error?.code === 'week_not_over')
  r = await call('POST', '/approvals/approve', { token: key, body: { week, personIds: [personId] } })
  check('approve the week', r.status === 200 && r.json?.approved === 1 && Math.abs(r.json?.results?.[0]?.hours - 2) < 0.01, JSON.stringify(r.json))
  r = await call('PATCH', `/punches/${addedId}`, { token: key, body: { notes: 'late change', reason: 'smoke' } })
  check('an approved week is frozen', r.status === 409 && r.json?.error?.code === 'week_approved')
  r = await call('POST', '/punches', { token: key, body: { personId, jobId, clockIn: new Date(past.getTime() + 3 * 3_600_000).toISOString(), clockOut: new Date(past.getTime() + 4 * 3_600_000).toISOString(), reason: 'smoke' } })
  check('no time can be added to an approved week', r.status === 409 && r.json?.error?.code === 'week_approved')
  r = await call('POST', '/approvals/reopen', { token: key, body: { week, personId } })
  check('reopening without a reason is refused', r.status === 400)
  r = await call('POST', '/approvals/reopen', { token: key, body: { week, personId, reason: 'smoke: fix a note' } })
  check('reopen the week', r.status === 200 && !r.json?.approval?.approvedAt)
  r = await call('PATCH', `/punches/${addedId}`, { token: key, body: { notes: 'late change', reason: 'smoke' } })
  check('a reopened week can be corrected', r.status === 200)
  r = await call('POST', '/approvals/sign', { token: tech, body: { week } })
  await call('PATCH', `/punches/${addedId}`, { token: key, body: { notes: 'another change', reason: 'smoke' } })
  r = await call('GET', `/me/week?week=${week}`, { token: tech })
  check('a change after signing clears the signature', r.status === 200 && r.json?.signedAt === null)

  r = await call('GET', `/reports/exceptions?from=${pastDay}&to=${pastDay}&personId=${personId}`, { token: key })
  const kinds = new Set((r.json?.data ?? []).map((e) => e.type))
  check('exceptions list who added and changed time', r.status === 200 && kinds.has('entered_by_other') && kinds.has('edited'), [...kinds].join(','))
  r = await call('GET', '/reports/exceptions', { token: tech })
  check('a tech cannot open the exceptions list', r.status === 403)

  // ─── Crew punch ──────────────────────────────────────────────────────────
  r = await call('POST', '/punches/crew', { token: tech, body: { action: 'in', personIds: [personId], jobId } })
  check('a tech cannot punch a crew', r.status === 403)
  r = await call('POST', '/punches/crew', { token: key, body: { action: 'in', personIds: [personId, 'no-such-person'], jobId } })
  check('crew clock-in: each person on their own', r.status === 200 && r.json?.ok === 1 && r.json?.failed === 1, JSON.stringify(r.json))
  r = await call('POST', '/punches/crew', { token: key, body: { action: 'next', personIds: [personId] } })
  check('crew next phase', r.status === 200 && r.json?.ok === 1 && r.json?.results?.[0]?.phaseKey === phases[1]?.key, JSON.stringify(r.json))
  r = await call('POST', '/punches/crew', { token: key, body: { action: 'out', personIds: [personId] } })
  check('crew clock-out', r.status === 200 && r.json?.ok === 1)

  // ─── Parallel run: hours from Timesheets.com beside ours ─────────────────
  const sys = `smoke-${stamp}`
  r = await call('PUT', `/external-hours/${sys}`, { token: key, body: { from: today, to: today, rows: [{ email: testEmail, date: today, hours: 0.25 }, { email: `nobody-${stamp}@example.invalid`, date: today, hours: 8 }] } })
  check('push the other system\'s hours', r.status === 200 && r.json?.stored === 1 && r.json?.unknownEmails?.length === 1, JSON.stringify(r.json))
  r = await call('GET', `/reports/reconcile?system=${sys}&from=${today}&to=${today}`, { token: key })
  const rec = r.json?.rows?.find((x) => x.personId === personId)
  check('reconcile shows ours, theirs and the difference', r.status === 200 && rec?.theirs === 0.25 && rec?.match === false && Math.abs(rec.diff - (rec.ours - 0.25)) < 0.01, JSON.stringify(rec))
  await call('PUT', `/external-hours/${sys}`, { token: key, body: { from: today, to: today, rows: [] } })

  // ─── Webhooks: a signed delivery reaches a listener ──────────────────────
  const got = []
  const listener = createServer((req, res) => {
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      got.push({ sig: req.headers['x-tt-signature'], raw })
      res.end('ok')
    })
  })
  await new Promise((ok) => listener.listen(0, '127.0.0.1', ok))
  try {
    const hookUrl = `http://127.0.0.1:${listener.address().port}/hook`
    r = await call('POST', '/webhooks', { token: key, body: { url: 'http://example.com/hook' } })
    check('a plain-http webhook to the internet is refused', r.status === 400)
    r = await call('POST', '/webhooks', { token: key, body: { url: hookUrl, events: ['punch.started'] } })
    check('subscribe a webhook', r.status === 201 && r.json?.secret?.startsWith('whsec_'), JSON.stringify(r.json?.error ?? ''))
    const hookId = r.json?.webhook?.id
    const secret = r.json?.secret
    const valid = (g) => g.sig === `sha256=${createHmac('sha256', secret).update(g.raw).digest('hex')}`
    r = await call('POST', `/webhooks/${hookId}/test`, { token: key })
    check('test delivery reaches the listener, signed', r.json?.result?.ok === true && got.length === 1 && valid(got[0]), JSON.stringify(r.json))
    await call('POST', '/punches/in', { token: key, headers: as, body: { jobId } })
    await call('POST', '/punches/out', { token: key, headers: as })
    for (let i = 0; i < 30 && got.length < 2; i++) await new Promise((ok) => setTimeout(ok, 500))
    const ev = got[1] ? JSON.parse(got[1].raw) : null
    check('a punch is delivered to the webhook, signed', ev?.type === 'punch.started' && valid(got[1]) && got.length === 2, `received ${got.length}`)
    r = await call('DELETE', `/webhooks/${hookId}`, { token: key })
    check('remove the webhook', r.status === 200)
  } finally {
    listener.close()
  }

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

  r = await call('GET', `/events?after=${startSeq}&limit=500`, { token: key })
  const types = new Set((r.json?.data ?? []).map((e) => e.type))
  check('change feed has the events', ['job.upserted', 'person.upserted', 'punch.started', 'punch.switched', 'punch.ended', 'punch.edited', 'punch.added', 'approval.signed', 'approval.approved', 'approval.reopened'].every((t) => types.has(t)), [...types].join(','))

  r = await call('GET', '/openapi.json')
  check('API describes itself', r.status === 200 && Boolean(r.json?.paths?.['/punches/in']?.post))

  // Clean up.
  await call('PUT', `/people/by-email/${encodeURIComponent(testEmail)}`, { token: key, body: { active: false } })
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
