import { Router, type Request } from 'express'
import { prisma } from '../db.js'
import { bool, limitOf, route, str } from '../api.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireAuth, requirePerson, requireScope, type Auth } from '../auth/middleware.js'
import { SELF } from '../auth/apiKeys.js'
import { localDate } from '../lib/time.js'
import { assertInDivision, divisionPersonIds, personFilterFor } from '../auth/division.js'
import {
  acknowledgeNotice,
  addAdjustment,
  assignPolicy,
  balancesFor,
  cancelLeaveRequest,
  commitImport,
  createLeaveRequest,
  createPolicy,
  decideLeaveRequest,
  ensureLeaveSetup,
  ledger,
  listLeaveRequests,
  pfmlQuarterly,
  previewImport,
  requireLeaveOn,
  runAccrual,
  runYearEnd,
  setProfile,
  statements,
  updatePolicy,
  usableFromFor,
  viewRequests,
  type ImportInput,
  type LeaveActor,
} from '../services/leave.js'

// Leave: §7 of TIME-TRACKING-APP.md. Every endpoint answers 403 leave_off unless
// LEAVE_ENABLED=true. People see and ask for their own leave; crew leads see who is
// off; managers, admins and payroll approve (never their own); payroll and admins keep
// the balances.

export const leaveRouter = Router()

const actorOf = (auth: Auth): LeaveActor => ({ companyId: auth.companyId, personId: auth.person?.id ?? null, apiKeyId: auth.apiKeyId })

/** The scopes for leave, after checking the switch. */
function leaveAuth(req: Request, ...anyOf: string[]): Auth {
  requireLeaveOn()
  return anyOf.length ? requireScope(req, ...anyOf) : requireAuth(req)
}

/** A leave request someone else made: only within a division admin's own division. */
async function assertLeaveInDivision(auth: Auth, requestId: string): Promise<void> {
  const r = await prisma.leaveRequest.findFirst({ where: { id: requestId, companyId: auth.companyId }, select: { personId: true } })
  if (r && r.personId !== auth.person?.id) await assertInDivision(auth, r.personId)
}

const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v))

// ─── The person's own leave ─────────────────────────────────────────────────

route(
  leaveRouter,
  { method: 'get', path: '/me/leave', tag: 'Leave', summary: 'Your balances, leave types, requests, and whether you have seen the sick-leave notice.', access: [SELF] },
  async (req) => {
    const auth = leaveAuth(req, SELF)
    const person = requirePerson(auth)
    const { settings, types } = await ensureLeaveSetup(auth.companyId)
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const today = localDate(new Date(), company.timezone)
    const [balances, requests, profile] = await Promise.all([
      balancesFor(auth.companyId, [person.id], today),
      prisma.leaveRequest.findMany({ where: { personId: person.id }, orderBy: { startDate: 'desc' }, take: 50 }),
      prisma.leaveProfile.findUnique({ where: { personId: person.id } }),
    ])
    const active = types.filter((t) => t.active)
    return {
      today,
      banks: settings.banks,
      types: await Promise.all(
        active.map(async (t) => ({
          id: t.id,
          key: t.key,
          name: t.name,
          paid: t.paid,
          drawsBalance: t.drawsBalance,
          statutory: t.statutory,
          // State family leave is applied for with the state; the office records it.
          requestable: t.statutory !== 'wa_pfml',
          usableFrom: await usableFromFor(auth.companyId, person.id, t.id, today),
        })),
      ),
      balances: active
        .filter((t) => t.drawsBalance)
        .map((t) => balances.find((b) => b.leaveTypeId === t.id) ?? { personId: person.id, leaveTypeId: t.id, balance: 0, pending: 0, available: 0, booked: 0 }),
      requests: await viewRequests(requests),
      hireDate: profile?.hireDate ?? null,
      noticeAckAt: profile?.noticeAckAt ?? null,
    }
  },
)

route(
  leaveRouter,
  { method: 'post', path: '/me/leave/notice', tag: 'Leave', summary: 'Record that you have read the written notice of your paid sick leave rights.', access: [SELF] },
  async (req) => {
    const auth = leaveAuth(req, SELF)
    const p = await acknowledgeNotice(requirePerson(auth))
    return { noticeAckAt: p.noticeAckAt }
  },
)

route(
  leaveRouter,
  { method: 'get', path: '/me/leave/ledger', tag: 'Leave', summary: 'Every entry on your balances, oldest first.', access: [SELF], query: { leaveTypeId: 'One leave type' } },
  async (req) => {
    const auth = leaveAuth(req, SELF)
    return { data: await ledger(auth.companyId, { personId: requirePerson(auth).id, leaveTypeId: str(req.query.leaveTypeId, 80) || undefined }) }
  },
)

route(
  leaveRouter,
  { method: 'get', path: '/me/leave/statement', tag: 'Leave', summary: 'Your monthly statement: earned, used and available per leave type.', access: [SELF], query: { month: 'YYYY-MM' } },
  async (req) => {
    const auth = leaveAuth(req, SELF)
    const person = requirePerson(auth)
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const month = str(req.query.month, 7) || localDate(new Date(), company.timezone).slice(0, 7)
    const s = await statements(auth.companyId, month, person.id)
    return s.statements[0] ?? null
  },
)

// ─── Types, settings, policies ──────────────────────────────────────────────

route(
  leaveRouter,
  { method: 'get', path: '/leave/types', tag: 'Leave', summary: 'Kinds of leave.', access: [SELF, 'leave:read'], division: 'scoped' },
  async (req) => {
    const auth = leaveAuth(req, SELF, 'leave:read')
    const { types } = await ensureLeaveSetup(auth.companyId)
    return { data: types }
  },
)

route(
  leaveRouter,
  { method: 'get', path: '/leave/settings', tag: 'Leave', summary: 'Company leave settings: separate or combined banks, sick payout, switchover day.', access: ['leave:read'], division: 'scoped' },
  async (req) => {
    const auth = leaveAuth(req, 'leave:read')
    return (await ensureLeaveSetup(auth.companyId)).settings
  },
)

route(
  leaveRouter,
  {
    method: 'patch',
    path: '/leave/settings',
    tag: 'Leave',
    summary: 'Change company leave settings. Banks can change only before any balance exists.',
    access: ['leave:write'],
    body: { banks: 'separate (sick and vacation) or combined (one PTO bank)', sickPayoutAtSeparation: 'true to pay the sick balance at separation (off at Morgan Sound)' },
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    const { settings } = await ensureLeaveSetup(auth.companyId)
    const data: { banks?: string; sickPayoutAtSeparation?: boolean } = {}
    if (req.body?.banks !== undefined) {
      const banks = String(req.body.banks)
      if (!['separate', 'combined'].includes(banks)) throw badRequest('banks must be separate or combined.', { field: 'banks' })
      if (banks !== settings.banks) {
        const any = await prisma.leaveLedger.count({ where: { companyId: auth.companyId } })
        if (any) throw conflict('leave_in_use', 'Balances already exist. Changing between separate and combined banks needs the balances moved by hand first.')
        // The old bank's types are switched off; the new ones are made below.
        const off = banks === 'combined' ? ['sick', 'vacation'] : ['pto']
        await prisma.leaveType.updateMany({ where: { companyId: auth.companyId, key: { in: off } }, data: { active: false } })
        const on = banks === 'combined' ? ['pto'] : ['sick', 'vacation']
        await prisma.leaveType.updateMany({ where: { companyId: auth.companyId, key: { in: on } }, data: { active: true } })
      }
      data.banks = banks
    }
    const payout = bool(req.body?.sickPayoutAtSeparation)
    if (payout !== undefined) data.sickPayoutAtSeparation = payout
    await prisma.leaveSettings.update({ where: { companyId: auth.companyId }, data })
    return (await ensureLeaveSetup(auth.companyId)).settings
  },
)

const POLICY_BODY = {
  leaveTypeId: 'Leave type (create only)',
  name: 'Name people see',
  method: 'per_hours_worked | per_period | annual_grant | none',
  rateHours: 'Hours earned per perHours worked (per_hours_worked)',
  perHours: 'Hours worked per rateHours earned (per_hours_worked)',
  periodHours: 'Hours per pay period (per_period) or per grant (annual_grant)',
  grantOn: 'jan1 or anniversary (annual_grant)',
  tiers: 'Years-of-service steps: [{ years, rateHours? , periodHours? }]',
  balanceCap: 'Accrual stops at this balance; null = none',
  carryoverMax: 'Balance kept past Dec 31; null = all',
  waitingDays: 'Usable this many days after the hire date',
  active: 'false to stop using it',
}

route(
  leaveRouter,
  { method: 'get', path: '/leave/policies', tag: 'Leave', summary: 'How each kind of leave is earned.', access: ['leave:read'], division: 'scoped' },
  async (req) => {
    const auth = leaveAuth(req, 'leave:read')
    await ensureLeaveSetup(auth.companyId)
    return { data: await prisma.leavePolicy.findMany({ where: { companyId: auth.companyId }, orderBy: { createdAt: 'asc' } }) }
  },
)

route(
  leaveRouter,
  { method: 'post', path: '/leave/policies', tag: 'Leave', summary: 'Add a policy. Sick leave (and a combined PTO bank) must meet every Washington rule.', access: ['leave:write'], body: POLICY_BODY, status: 201 },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    return { policy: await createPolicy(auth.companyId, req.body ?? {}) }
  },
)

route(
  leaveRouter,
  { method: 'patch', path: '/leave/policies/:id', tag: 'Leave', summary: 'Change a policy. Applies to accruals run from now on.', access: ['leave:write'], body: POLICY_BODY },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    return { policy: await updatePolicy(auth.companyId, req.params.id, req.body ?? {}) }
  },
)

// ─── People ─────────────────────────────────────────────────────────────────

route(
  leaveRouter,
  {
    method: 'get',
    path: '/leave/balances',
    tag: 'Leave',
    summary: "Everyone's balances, hire date and the policy each person is on.",
    access: ['leave:read'],
    division: 'scoped',
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:read')
    const { types } = await ensureLeaveSetup(auth.companyId)
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const today = localDate(new Date(), company.timezone)
    const only = await divisionPersonIds(auth)
    const [people, balances, profiles, assigned] = await Promise.all([
      prisma.person.findMany({ where: { companyId: auth.companyId, active: true, id: only ? { in: only } : undefined }, orderBy: { name: 'asc' } }),
      balancesFor(auth.companyId, only ?? undefined, today),
      prisma.leaveProfile.findMany({ where: { companyId: auth.companyId } }),
      prisma.personLeavePolicy.findMany({ where: { companyId: auth.companyId, effectiveFrom: { lte: today }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] } }),
    ])
    const profile = new Map(profiles.map((p) => [p.personId, p]))
    return {
      today,
      types: types.filter((t) => t.active),
      people: people.map((p) => ({
        id: p.id,
        name: p.name,
        email: p.email,
        role: p.role,
        hireDate: profile.get(p.id)?.hireDate ?? null,
        noticeAckAt: profile.get(p.id)?.noticeAckAt ?? null,
        policies: Object.fromEntries(assigned.filter((a) => a.personId === p.id).map((a) => [a.leaveTypeId, a.leavePolicyId])),
        balances: balances.filter((b) => b.personId === p.id),
      })),
    }
  },
)

route(
  leaveRouter,
  { method: 'get', path: '/people/:id/leave/balances', tag: 'Leave', summary: "One person's balance per leave type.", access: ['leave:read', SELF], division: 'scoped' },
  async (req) => {
    const auth = leaveAuth(req, 'leave:read', SELF)
    if (!auth.scopes.has('leave:read') && auth.person?.id !== req.params.id) throw forbidden('You can see your own balances only.')
    if (auth.person?.id !== req.params.id) await assertInDivision(auth, req.params.id)
    const person = await prisma.person.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!person) throw notFound('Person')
    return { data: await balancesFor(auth.companyId, [person.id]) }
  },
)

route(
  leaveRouter,
  {
    method: 'put',
    path: '/people/:id/leave/policies',
    tag: 'Leave',
    summary: 'Put a person on a policy for one leave type from a date (null policy ends it). The previous one ends the day before.',
    access: ['leave:write'],
    body: { leaveTypeId: 'Leave type', leavePolicyId: 'Policy, or null to end the current one', effectiveFrom: 'YYYY-MM-DD' },
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const policyId = req.body?.leavePolicyId === null || req.body?.leavePolicyId === '' ? null : str(req.body?.leavePolicyId, 80)
    const from = str(req.body?.effectiveFrom, 10) || localDate(new Date(), company.timezone)
    return { assignment: await assignPolicy(auth.companyId, req.params.id, str(req.body?.leaveTypeId, 80), policyId, from) }
  },
)

route(
  leaveRouter,
  { method: 'patch', path: '/people/:id/leave/profile', tag: 'Leave', summary: "Set a person's hire date (the 90-day sick-leave wait and years-of-service tiers count from it).", access: ['leave:write'], body: { hireDate: 'YYYY-MM-DD, or null' } },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    return { profile: await setProfile(auth.companyId, req.params.id, { hireDate: req.body?.hireDate === null ? null : str(req.body?.hireDate, 10) }) }
  },
)

// ─── Requests ───────────────────────────────────────────────────────────────

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/requests',
    tag: 'Leave',
    summary:
      'Ask for time off. Approvers can also record leave for someone else (personId), e.g. a state family-leave period, and approve it at once (approve: true). ' +
      'No reason is asked for; for sick leave none is kept.',
    access: [SELF, 'leave:approve'],
    status: 201,
    body: {
      personId: 'Whose leave. Default: you',
      leaveTypeId: 'Kind of leave',
      startDate: 'First day, YYYY-MM-DD',
      endDate: 'Last day, YYYY-MM-DD. Default: startDate',
      hoursPerDay: 'Hours each work day. Default 8',
      includeWeekends: 'true to count Saturday and Sunday too',
      days: 'Instead of the above: [{ date, hours }]',
      note: 'Optional scheduling note (not kept for sick leave)',
      approve: 'Approvers recording leave for someone else: true to approve at once',
    },
    division: 'scoped',
  },
  async (req) => {
    const auth = leaveAuth(req, SELF, 'leave:approve')
    const b = req.body ?? {}
    const personId = str(b.personId, 80) || auth.person?.id
    if (!personId) throw badRequest('personId is required with an API key.', { field: 'personId' })
    if (personId !== auth.person?.id) await assertInDivision(auth, personId)
    const days = Array.isArray(b.days) ? (b.days as { date: unknown; hours: unknown }[]).map((d) => ({ date: str(d.date, 10), hours: Number(d.hours) })) : undefined
    const created = await createLeaveRequest(
      actorOf(auth),
      auth.scopes,
      {
        personId,
        leaveTypeId: str(b.leaveTypeId, 80),
        startDate: str(b.startDate, 10),
        endDate: str(b.endDate, 10) || undefined,
        hoursPerDay: num(b.hoursPerDay),
        includeWeekends: bool(b.includeWeekends) ?? false,
        days,
        note: str(b.note, 300),
      },
      bool(b.approve) ?? false,
    )
    return { request: (await viewRequests([created]))[0] }
  },
)

route(
  leaveRouter,
  {
    method: 'get',
    path: '/leave/requests',
    tag: 'Leave',
    summary: 'Leave requests, filterable. pending lists the oldest first.',
    access: ['leave:read'],
    query: { status: 'pending | approved | denied | cancelled', personId: 'One person', from: 'Leave on or after YYYY-MM-DD', to: 'Leave on or before YYYY-MM-DD', limit: 'Default 200' },
    division: 'scoped',
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:read')
    return {
      data: await listLeaveRequests(auth.companyId, {
        status: str(req.query.status, 20) || undefined,
        personId: await personFilterFor(auth, str(req.query.personId, 80) || undefined),
        from: str(req.query.from, 10) || undefined,
        to: str(req.query.to, 10) || undefined,
        limit: limitOf(req.query.limit, 200, 1000),
      }),
    }
  },
)

for (const decision of ['approve', 'deny'] as const) {
  route(
    leaveRouter,
    {
      method: 'post',
      path: `/leave/requests/:id/${decision}`,
      tag: 'Leave',
      summary: decision === 'approve' ? 'Approve a request: the hours come off the balance. Not your own.' : 'Turn a request down. A note saying why is required.',
      access: ['leave:approve'],
      body: { note: decision === 'approve' ? 'Optional' : 'Why (required)' },
      division: 'scoped',
    },
    async (req) => {
      const auth = leaveAuth(req, 'leave:approve')
      await assertLeaveInDivision(auth, req.params.id)
      const u = await decideLeaveRequest(actorOf(auth), req.params.id, decision, str(req.body?.note, 300))
      return { request: (await viewRequests([u]))[0] }
    },
  )
}

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/requests/:id/cancel',
    tag: 'Leave',
    summary: 'Withdraw your own request (or approved leave that has not started). Approvers can cancel approved leave; the hours go back on the balance.',
    access: [SELF, 'leave:approve'],
    body: { note: 'Optional' },
    division: 'scoped',
  },
  async (req) => {
    const auth = leaveAuth(req, SELF, 'leave:approve')
    await assertLeaveInDivision(auth, req.params.id)
    const u = await cancelLeaveRequest(actorOf(auth), auth.scopes, req.params.id, str(req.body?.note, 300))
    return { request: (await viewRequests([u]))[0] }
  },
)

// ─── Balances: adjustments, accrual, year end, ledger, statements ──────────

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/adjustments',
    tag: 'Leave',
    summary: 'Correct a balance by hand. A note saying why is required. Not on your own balance.',
    access: ['leave:write'],
    status: 201,
    body: { personId: 'Whose', leaveTypeId: 'Which leave', hours: '+ adds, - takes off', date: 'YYYY-MM-DD. Default today', kind: 'adjustment (default), payout, reinstate, carryover or forfeit', note: 'Why (required)' },
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    const b = req.body ?? {}
    return {
      entry: await addAdjustment(actorOf(auth), {
        personId: str(b.personId, 80),
        leaveTypeId: str(b.leaveTypeId, 80),
        hours: Number(b.hours),
        date: str(b.date, 10) || undefined,
        kind: str(b.kind, 20) || undefined,
        note: str(b.note, 300),
      }),
    }
  },
)

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/accruals/run',
    tag: 'Leave',
    summary:
      'Earn leave for a pay period from approved hours (every hour worked: overtime and travel count; leave taken does not). Safe to repeat: a re-run posts only the difference. ' +
      'Weeks not approved yet are listed under notReady and count once approved and re-run.',
    access: ['leave:write'],
    body: { from: 'First day of the pay period', to: 'Last day', dryRun: 'true to see the result without posting' },
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    return runAccrual(actorOf(auth), str(req.body?.from, 10), str(req.body?.to, 10), { dryRun: bool(req.body?.dryRun) ?? false })
  },
)

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/year-end',
    tag: 'Leave',
    summary: "After Dec 31: forfeit anything over each policy's carryover limit (sick leave keeps at least 40 hours). Safe to repeat.",
    access: ['leave:write'],
    body: { year: 'The year that ended', dryRun: 'true to see the result without posting' },
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    return runYearEnd(actorOf(auth), Number(req.body?.year), { dryRun: bool(req.body?.dryRun) ?? false })
  },
)

route(
  leaveRouter,
  {
    method: 'get',
    path: '/leave/ledger',
    tag: 'Leave',
    summary: 'Every accrual, use and adjustment, oldest first.',
    access: ['leave:read'],
    query: { personId: 'One person', leaveTypeId: 'One leave type', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', limit: 'Default 1000' },
    division: 'scoped',
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:read')
    return {
      data: await ledger(auth.companyId, {
        personId: await personFilterFor(auth, str(req.query.personId, 80) || undefined),
        leaveTypeId: str(req.query.leaveTypeId, 80) || undefined,
        from: str(req.query.from, 10) || undefined,
        to: str(req.query.to, 10) || undefined,
        limit: limitOf(req.query.limit, 1000, 5000),
      }),
    }
  },
)

route(
  leaveRouter,
  { method: 'get', path: '/leave/statements', tag: 'Leave', summary: 'Monthly statement per person: earned, used and available per leave type.', access: ['leave:read'], query: { month: 'YYYY-MM', personId: 'One person' }, division: 'scoped' },
  async (req) => {
    const auth = leaveAuth(req, 'leave:read')
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const month = str(req.query.month, 7) || localDate(new Date(), company.timezone).slice(0, 7)
    return statements(auth.companyId, month, await personFilterFor(auth, str(req.query.personId, 80) || undefined))
  },
)

route(
  leaveRouter,
  {
    method: 'get',
    path: '/reports/pfml-quarterly',
    tag: 'Leave',
    summary: 'Hours per person in a quarter, for the state Paid Family and Medical Leave report. Premiums stay with payroll.',
    access: ['payroll:read'],
    query: { year: 'e.g. 2026', quarter: '1 to 4' },
  },
  async (req) => {
    const auth = leaveAuth(req, 'payroll:read')
    return pfmlQuarterly(auth.companyId, Number(req.query.year), Number(req.query.quarter))
  },
)

// ─── Opening balances ───────────────────────────────────────────────────────

const IMPORT_BODY = {
  fileName: 'The file name (.xlsx or .csv)',
  contentBase64: 'The file, base64',
  mapping: '{ headerRow, nameCol, emailCol, columns: [{ col, leaveTypeId }] }. Omit on the first preview to have it guessed',
  chosen: '{ "<sheet row>": personId } for rows matched by hand',
  skip: 'Sheet rows to leave out',
  switchoverDate: 'YYYY-MM-DD the balances are as of',
}

const importInput = (b: Record<string, unknown> | undefined): ImportInput => ({
  fileName: str(b?.fileName, 200),
  contentBase64: typeof b?.contentBase64 === 'string' ? b.contentBase64 : '',
  mapping: b?.mapping as ImportInput['mapping'],
  chosen: (b?.chosen ?? {}) as Record<string, string>,
  skip: Array.isArray(b?.skip) ? (b.skip as number[]) : [],
  switchoverDate: str(b?.switchoverDate, 10) || undefined,
})

route(
  leaveRouter,
  { method: 'post', path: '/leave/import/preview', tag: 'Leave', summary: 'Read the finance spreadsheet and show who matched and what would be posted. Writes nothing.', access: ['leave:write'], body: IMPORT_BODY },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    return previewImport(auth.companyId, importInput(req.body))
  },
)

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/import/commit',
    tag: 'Leave',
    summary: 'Post the opening balances: one adjustment per person per leave type, dated the switchover day. Refused while any row needs a look.',
    access: ['leave:write'],
    body: IMPORT_BODY,
  },
  async (req) => {
    const auth = leaveAuth(req, 'leave:write')
    return commitImport(actorOf(auth), importInput(req.body))
  },
)
