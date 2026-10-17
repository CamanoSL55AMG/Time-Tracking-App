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
  check(
    'every phase names its labor category',
    allPhases.every((p) => typeof p.laborCategory === 'string' && p.laborCategory !== '' && typeof p.dayFlow === 'boolean'),
    JSON.stringify(allPhases.map((p) => [p.key, p.laborCategory, p.dayFlow])),
  )

  r = await call('POST', '/api-keys', { token: admin, body: { name: `smoke ${stamp}`, scopes: ['punch:read', 'punch:write:any', 'jobs:read', 'jobs:write', 'people:read', 'people:write', 'reports:read', 'events:read', 'assignments:write', 'expenses:read', 'expenses:write', 'expenses:approve', 'leave:read', 'leave:write', 'leave:approve'] } })
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
  check('a tech sees their own day', r.status === 200 && r.json?.today?.length >= 2 && r.json?.phases?.length === allPhases.length)


  // ─── Expenses ───────────────────────────────────────────────────────────────
  r = await call('GET', '/expense-categories', { token: tech })
  const cats = r.json?.data ?? []
  const fuel = cats.find((c) => !c.mileage)
  const mileCat = cats.find((c) => c.mileage)
  check('a tech sees the expense categories', r.status === 200 && Boolean(fuel) && Boolean(mileCat), JSON.stringify(cats.map((c) => c.name)))
  r = await call('GET', '/mileage-rates', { token: tech })
  const rateMills = r.json?.current?.rateMills
  check('a mileage rate is in force', r.status === 200 && Number.isInteger(rateMills), JSON.stringify(r.json?.current ?? null))

  r = await call('POST', '/expenses', { token: tech, body: { date: today, categoryId: fuel?.id, jobId, amount: '45.67', vendor: 'Smoke Fuel', clientId: `e1-${stamp}` } })
  check('a tech adds an expense', r.status === 201 && r.json?.expense?.amountCents === 4567 && r.json?.expense?.editable === true, JSON.stringify(r.json))
  const fuelLine = r.json?.expense?.id
  r = await call('POST', '/expenses', { token: tech, body: { date: today, categoryId: fuel?.id, amount: '45.67', clientId: `e1-${stamp}` } })
  check('re-sending the same expense clientId does nothing', r.json?.duplicate === true && r.json?.expense?.id === fuelLine)
  r = await call('POST', '/expenses', { token: tech, body: { date: today, categoryId: mileCat?.id, jobId, miles: 42.3 } })
  check('mileage is miles × the rate', r.status === 201 && r.json?.expense?.amountCents === Math.round((42.3 * rateMills) / 10), JSON.stringify(r.json?.expense ?? r.json))
  const mileLine = r.json?.expense?.id
  r = await call('POST', '/expenses', { token: tech, body: { date: today, categoryId: fuel?.id, amount: '12.345' } })
  check('an amount with three decimals is refused', r.status === 400)
  r = await call('POST', '/expenses', { token: tech, body: { date: today, categoryId: mileCat?.id } })
  check('mileage without miles is refused', r.status === 400)

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64')
  let raw = await fetch(`${api}/expenses/${fuelLine}/receipt`, { method: 'POST', headers: { Authorization: `Bearer ${tech}`, 'Content-Type': 'image/png' }, body: png })
  check('attach a receipt photo', raw.status === 200, String(raw.status))
  raw = await fetch(`${api}/expenses/${fuelLine}/receipt`, { headers: { Authorization: `Bearer ${tech}` } })
  check('the receipt comes back as the file', raw.status === 200 && raw.headers.get('content-type') === 'image/png' && (await raw.arrayBuffer()).byteLength === png.length)
  raw = await fetch(`${api}/expenses/${fuelLine}/receipt`, { method: 'POST', headers: { Authorization: `Bearer ${tech}`, 'Content-Type': 'text/plain' }, body: 'nope' })
  check('a receipt that is not a photo or PDF is refused', raw.status === 415, String(raw.status))

  r = await call('POST', '/expense-reports', { token: tech, body: { title: `Smoke ${stamp}`, submit: true } })
  const report = r.json?.report
  check('submit the lines as one report', r.status === 201 && report?.status === 'submitted' && report?.lines?.length === 2 && report?.missingReceipts === 0, JSON.stringify(r.json?.error ?? report))
  r = await call('PATCH', `/expenses/${fuelLine}`, { token: tech, body: { amount: '1.00' } })
  check('a submitted line is locked', r.status === 409 && r.json?.error?.code === 'expense_locked')
  r = await call('POST', `/expense-reports/${report?.id}/approve`, { token: tech })
  check('a tech cannot approve expenses', r.status === 403)
  r = await call('POST', `/expense-reports/${report?.id}/reject`, { token: key })
  check('sending back needs a note', r.status === 400)
  r = await call('POST', `/expense-reports/${report?.id}/reject`, { token: key, body: { note: 'Add the job to the fuel line' } })
  check('send a report back', r.status === 200 && r.json?.report?.status === 'rejected')
  r = await call('PATCH', `/expenses/${fuelLine}`, { token: tech, body: { amount: '40.00' } })
  check('a sent-back line can be fixed', r.status === 200 && r.json?.expense?.amountCents === 4000)
  r = await call('POST', `/expense-reports/${report?.id}/submit`, { token: tech })
  check('submit it again', r.status === 200 && r.json?.report?.status === 'submitted')
  r = await call('POST', `/expense-reports/${report?.id}/approve`, { token: key, body: { note: 'ok' } })
  check('approve the report', r.status === 200 && r.json?.report?.status === 'approved')
  r = await call('DELETE', `/expenses/${mileLine}`, { token: tech })
  check('an approved line cannot be deleted', r.status === 409)
  r = await call('POST', `/expense-reports/${report?.id}/mark-exported`, { token: key })
  check('mark it exported', r.status === 200 && r.json?.report?.status === 'exported')
  r = await call('GET', `/reports/expenses?groupBy=job,category&jobId=${jobId}`, { token: key })
  check('expense totals by job', r.status === 200 && r.json?.totalCents === 4000 + Math.round((42.3 * rateMills) / 10) && r.json?.rows?.length === 2, JSON.stringify(r.json))
  r = await call('GET', '/expenses', { token: tech })
  check('a tech lists only their own expenses', r.status === 200 && r.json?.data?.length === 2 && r.json.data.every((e) => e.personId === row?.personId))

  // ─── Leave ──────────────────────────────────────────────────────────────────
  const personId = row?.personId
  r = await call('GET', '/leave/types', { token: tech })
  const leaveTypes = r.json?.data ?? []
  const sickType = leaveTypes.find((x) => x.statutory === 'wa_sick')
  const vacType = leaveTypes.find((x) => x.key === 'vacation')
  check('sick leave and vacation are separate kinds', Boolean(sickType) && Boolean(vacType) && sickType.id !== vacType.id)
  const ymdAgo = (d) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10)
  const ahead = (d) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10)

  r = await call('PUT', `/people/${personId}/hire-date`, { token: key, body: { hireDate: ymdAgo(10) } })
  check('set a start date', r.status === 200 && r.json?.person?.hireDate === ymdAgo(10))
  r = await call('POST', '/leave/requests', { token: tech, body: { leaveTypeId: sickType?.id, startDate: ahead(5), hours: 8 } })
  check('sick leave before day 90 is refused with the date', r.status === 409 && r.json?.error?.code === 'not_yet_usable' && Boolean(r.json?.error?.details?.usableFrom), JSON.stringify(r.json))
  await call('PUT', `/people/${personId}/hire-date`, { token: key, body: { hireDate: ymdAgo(200) } })
  r = await call('POST', '/leave/requests', { token: tech, body: { leaveTypeId: sickType?.id, startDate: ahead(5), hours: 8 } })
  check('sick leave with no hours earned is refused', r.status === 409 && r.json?.error?.code === 'insufficient_balance')

  const opening = { date: today, rows: [{ email: testEmail, leaveType: 'vacation', hours: 16 }] }
  r = await call('POST', '/leave/opening-balances', { token: key, body: { ...opening, dryRun: true } })
  check('opening balances: dry run matches the row', r.status === 200 && r.json?.ready === 1 && r.json?.imported === 0, JSON.stringify(r.json))
  r = await call('POST', '/leave/opening-balances', { token: key, body: opening })
  check('opening balances: import', r.status === 200 && r.json?.imported === 1)
  r = await call('POST', '/leave/opening-balances', { token: key, body: opening })
  check('opening balances: importing twice does not double', r.status === 200 && r.json?.alreadyImported === 1 && r.json?.imported === 0)

  r = await call('POST', '/leave/requests', { token: tech, body: { leaveTypeId: vacType?.id, startDate: ahead(30), endDate: ahead(30), hours: 8, note: 'smoke' } })
  check('a tech asks for time off', r.status === 201 && r.json?.request?.status === 'requested', JSON.stringify(r.json))
  const leaveId = r.json?.request?.id
  r = await call('POST', '/leave/requests', { token: tech, body: { leaveTypeId: vacType?.id, startDate: ahead(40), hours: 9 } })
  check('asking for more than is left after pending requests is refused', r.status === 409 && r.json?.error?.code === 'insufficient_balance' && r.json?.error?.details?.available === 8, JSON.stringify(r.json))
  r = await call('POST', '/leave/requests', { token: tech, body: { leaveTypeId: vacType?.id, startDate: ahead(30), hours: 1 } })
  check('overlapping requests are refused', r.status === 409 && r.json?.error?.code === 'leave_overlap')
  r = await call('POST', `/leave/requests/${leaveId}/approve`, { token: tech })
  check('a tech cannot approve time off', r.status === 403)
  r = await call('POST', `/leave/requests/${leaveId}/deny`, { token: key })
  check('denying needs a note', r.status === 400)
  r = await call('POST', `/leave/requests/${leaveId}/approve`, { token: key })
  check('approve the time off', r.status === 200 && r.json?.request?.status === 'approved')
  r = await call('POST', `/leave/requests/${leaveId}/approve`, { token: key })
  check('approving twice is refused', r.status === 409)
  r = await call('GET', '/me/leave', { token: tech })
  const vacBal = r.json?.types?.find((x) => x.leaveType.id === vacType?.id)
  check('the balance shows the approved hours used', r.status === 200 && vacBal?.balance === 8 && vacBal?.available === 8, JSON.stringify(vacBal))
  r = await call('POST', `/leave/requests/${leaveId}/cancel`, { token: tech })
  check('a tech cancels approved time off before it starts', r.status === 200 && r.json?.request?.status === 'cancelled')
  r = await call('GET', `/people/${personId}/leave`, { token: key })
  check('cancelling puts the hours back', r.json?.types?.find((x) => x.leaveType.id === vacType?.id)?.balance === 16, JSON.stringify(r.json?.types))
  r = await call('GET', `/leave/ledger?personId=${personId}&leaveTypeId=${vacType?.id}`, { token: key })
  check('the ledger explains the balance line by line', r.status === 200 && r.json?.data?.length === 3 && r.json.data[2].balanceAfter === 16, JSON.stringify(r.json?.data))

  r = await call('POST', '/leave/adjustments', { token: key, body: { personId, leaveTypeId: vacType?.id, hours: -2 } })
  check('a correction without a reason is refused', r.status === 400)
  r = await call('POST', '/leave/adjustments', { token: key, body: { personId, leaveTypeId: vacType?.id, hours: -2, reason: 'smoke correction' } })
  check('correct a balance', r.status === 201 && r.json?.balance === 14, JSON.stringify(r.json))
  r = await call('POST', '/leave/policies', { token: key, body: { leaveTypeId: sickType?.id, name: 'too stingy', rateHours: 1, perHours: 60 } })
  check('a sick policy below the Washington minimum is refused', r.status === 400)

  r = await call('POST', '/leave/accruals/run', { token: key, body: {} })
  check('run accruals', r.status === 200 && typeof r.json?.entries === 'number', JSON.stringify(r.json))
  r = await call('POST', '/leave/accruals/run', { token: key, body: {} })
  check('running accruals again adds nothing', r.status === 200 && r.json?.entries === 0, JSON.stringify(r.json))
  r = await call('GET', `/leave/statements?month=${today.slice(0, 7)}&personId=${personId}`, { token: key })
  const stmt = r.json?.statements?.[0]?.lines?.find((l) => l.leaveType.id === vacType?.id)
  check('monthly statement', r.status === 200 && stmt?.closing === 14, JSON.stringify(r.json))
  r = await call('GET', '/board', { token: key })
  check('the board still loads with leave on it', r.status === 200 && Array.isArray(r.json?.rows))

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

  r = await call('GET', '/events?after=0&limit=500', { token: key })
  const types = new Set((r.json?.data ?? []).map((e) => e.type))
  check('change feed has the events', ['job.upserted', 'person.upserted', 'punch.started', 'punch.switched', 'punch.ended', 'punch.edited', 'expense.submitted', 'expense.rejected', 'expense.approved', 'expense.exported', 'leave.requested', 'leave.approved', 'leave.cancelled', 'leave.adjusted'].every((t) => types.has(t)), [...types].join(','))

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
