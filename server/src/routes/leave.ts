import { Router, type Request } from 'express'
import type { Person, Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { bool, limitOf, requiredStr, route, str } from '../api.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireAuth, requirePerson, requireScope, type Auth } from '../auth/middleware.js'
import { KEYS_MANAGE, SELF } from '../auth/apiKeys.js'
import { ACCRUAL_METHODS, parseTiers, roundHours } from '../lib/leave.js'
import { addDays, hoursBetween, startOfLocalDay } from '../lib/time.js'
import {
  accrueThrough,
  adjust,
  ADJUST_KINDS,
  assertMonth,
  cancelRequest,
  createRequest,
  decideRequest,
  hoursOf,
  importOpening,
  leaveRequestInclude,
  personLeave,
  policyView,
  statements,
  todayIn,
  typeView,
  yearEnd,
  ymd,
  type OpeningRow,
} from '../services/leave.js'

// Leave: Washington paid sick leave, vacation and the other kinds of time off.
// Balances come from the ledger; see services/leave.ts.

export const leaveRouter = Router()

const STATUTORY = ['wa_sick', 'wa_pfml', 'none']
const isAdmin = (auth: Auth) => auth.scopes.has(KEYS_MANAGE)
const deciderOf = (auth: Auth) => ({ companyId: auth.companyId, personId: auth.via === 'session' ? auth.person?.id ?? null : null, isAdmin: isAdmin(auth) })

async function personIn(companyId: string, id: string): Promise<Person> {
  const p = await prisma.person.findFirst({ where: { id, companyId } })
  if (!p) throw notFound('Person')
  return p
}

/** Own data with SELF, anyone's with `scope`. */
function mayRead(auth: Auth, personId: string, scope = 'leave:read') {
  if (auth.scopes.has(scope)) return
  if (auth.scopes.has(SELF) && auth.person?.id === personId) return
  throw forbidden('That is not your leave.')
}

const companyTz = async (companyId: string) => (await prisma.company.findUniqueOrThrow({ where: { id: companyId } })).timezone

// ─── Types and policies ─────────────────────────────────────────────────────

route(
  leaveRouter,
  { method: 'get', path: '/leave/types', tag: 'Leave', summary: 'Kinds of leave, in order.', access: [SELF, 'leave:read'], query: { active: 'true (default), false, or all' } },
  async (req) => {
    const auth = requireScope(req, SELF, 'leave:read')
    const rows = await prisma.leaveType.findMany({
      where: { companyId: auth.companyId, active: req.query.active === 'all' ? undefined : bool(req.query.active) ?? true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    return { data: rows.map(typeView) }
  },
)

function typeFields(b: Record<string, unknown>, creating: boolean) {
  const statutory = b.statutory === undefined ? undefined : str(b.statutory, 20)
  if (statutory !== undefined && !STATUTORY.includes(statutory)) throw badRequest(`statutory must be one of ${STATUTORY.join(', ')}.`, { field: 'statutory' })
  return {
    name: b.name === undefined && !creating ? undefined : requiredStr(b.name, 'name', 80),
    paid: bool(b.paid),
    drawsBalance: bool(b.drawsBalance),
    statutory,
    sortOrder: b.sortOrder === undefined ? undefined : Math.round(Number(b.sortOrder)) || 0,
    active: bool(b.active),
  }
}

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/types',
    tag: 'Leave',
    summary: 'Add a kind of leave, e.g. bereavement or jury duty.',
    access: ['leave:write'],
    status: 201,
    body: { key: 'Stable slug, e.g. "bereavement"', name: 'Name', paid: 'true or false', drawsBalance: 'true if it uses up a balance', statutory: 'wa_sick | wa_pfml | none', sortOrder: 'Position' },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const b = req.body ?? {}
    const f = typeFields(b, true)
    const key = requiredStr(b.key, 'key', 40).toLowerCase()
    if (!/^[a-z0-9-]+$/.test(key)) throw badRequest('key may use only a-z, 0-9 and dashes.', { field: 'key' })
    const t = await prisma.leaveType.create({
      data: { companyId: auth.companyId, key, name: f.name!, paid: f.paid ?? true, drawsBalance: f.drawsBalance ?? true, statutory: f.statutory ?? 'none', sortOrder: f.sortOrder ?? 100 },
    })
    return { leaveType: typeView(t) }
  },
)

route(
  leaveRouter,
  { method: 'patch', path: '/leave/types/:id', tag: 'Leave', summary: 'Change a kind of leave.', access: ['leave:write'], body: { name: 'Name', paid: 'true or false', drawsBalance: 'true or false', sortOrder: 'Position', active: 'false hides it from requests' } },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const existing = await prisma.leaveType.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!existing) throw notFound('Leave type')
    const f = typeFields(req.body ?? {}, false)
    const t = await prisma.leaveType.update({ where: { id: existing.id }, data: f })
    return { leaveType: typeView(t) }
  },
)

function policyFields(b: Record<string, unknown>, creating: boolean) {
  const num = (v: unknown, field: string, { nullable = false, min = 0 } = {}) => {
    if (v === undefined) return undefined
    if (v === null || v === '') {
      if (nullable) return null
      throw badRequest(`${field} is required.`, { field })
    }
    const n = Number(v)
    if (!Number.isFinite(n) || n < min) throw badRequest(`${field} must be a number of at least ${min}.`, { field })
    return n
  }
  const method = b.method === undefined ? undefined : str(b.method, 30)
  if (method !== undefined && !(ACCRUAL_METHODS as readonly string[]).includes(method)) throw badRequest(`method must be one of ${ACCRUAL_METHODS.join(', ')}.`, { field: 'method' })
  const grantOn = b.grantOn === undefined ? undefined : str(b.grantOn, 20)
  if (grantOn !== undefined && !['calendar', 'anniversary'].includes(grantOn)) throw badRequest('grantOn must be calendar or anniversary.', { field: 'grantOn' })
  const f = {
    name: b.name === undefined && !creating ? undefined : requiredStr(b.name, 'name', 120),
    method,
    rateHours: num(b.rateHours, 'rateHours') as number | undefined,
    perHours: num(b.perHours, 'perHours', { min: 1 }) as number | undefined,
    grantOn,
    capHours: num(b.capHours, 'capHours', { nullable: true }) as number | null | undefined,
    carryoverMax: num(b.carryoverMax, 'carryoverMax', { nullable: true }) as number | null | undefined,
    waitingDays: b.waitingDays === undefined ? undefined : Math.round(num(b.waitingDays, 'waitingDays') ?? 0),
    tiers: b.tiers === undefined ? undefined : (parseTiers(b.tiers) as unknown as Prisma.InputJsonValue),
    appliesToAll: bool(b.appliesToAll),
    active: bool(b.active),
  }
  if (creating && f.rateHours === undefined) throw badRequest('rateHours is required.', { field: 'rateHours' })
  return f
}

/** Washington's floor for sick leave: a policy for wa_sick may be more generous, never less. */
async function checkSickFloor(leaveTypeId: string, p: { method?: string; rateHours?: number; perHours?: number; carryoverMax?: number | null; waitingDays?: number }) {
  const type = await prisma.leaveType.findUnique({ where: { id: leaveTypeId } })
  if (type?.statutory !== 'wa_sick') return
  if (p.method !== undefined && p.method !== 'per_hours_worked') return // a front-loaded grant is checked by whoever sets it
  if (p.rateHours !== undefined && p.perHours !== undefined && p.rateHours / p.perHours < 1 / 40 - 1e-9) {
    throw badRequest('Washington sick leave must accrue at least 1 hour for every 40 hours worked.', { field: 'rateHours' })
  }
  if (p.carryoverMax !== undefined && p.carryoverMax !== null && p.carryoverMax < 40) {
    throw badRequest('Washington sick leave must carry over at least 40 hours a year.', { field: 'carryoverMax' })
  }
  if (p.waitingDays !== undefined && p.waitingDays > 90) {
    throw badRequest('Washington sick leave must be usable from the 90th day of work.', { field: 'waitingDays' })
  }
}

route(
  leaveRouter,
  { method: 'get', path: '/leave/policies', tag: 'Leave', summary: 'Accrual rules.', access: ['leave:read'] },
  async (req) => {
    const auth = requireScope(req, 'leave:read')
    const rows = await prisma.leavePolicy.findMany({ where: { companyId: auth.companyId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] })
    const counts = await prisma.personLeavePolicy.groupBy({ by: ['leavePolicyId'], where: { companyId: auth.companyId, effectiveTo: null }, _count: { _all: true } })
    return { data: rows.map((p) => ({ ...policyView(p), assignedPeople: counts.find((c) => c.leavePolicyId === p.id)?._count._all ?? 0 })) }
  },
)

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/policies',
    tag: 'Leave',
    summary: 'Add an accrual rule for a kind of leave.',
    access: ['leave:write'],
    status: 201,
    body: {
      leaveTypeId: 'Kind of leave (required)',
      name: 'e.g. "Vacation, office staff"',
      method: 'per_hours_worked | per_month | annual_grant',
      rateHours: 'Hours earned per perHours worked, per month, or per grant',
      perHours: 'per_hours_worked only; default 40',
      grantOn: 'annual_grant only: calendar (1 Jan) or anniversary',
      capHours: 'Accrual stops while the balance is at or above this; null for none',
      carryoverMax: 'Hours above this are forfeited at year end; null for no limit',
      waitingDays: 'Usable from this many days after the start date',
      tiers: '[{ afterYears, rateHours }] steps by years of service',
      appliesToAll: 'true to cover everyone without assigning it',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const b = req.body ?? {}
    const leaveTypeId = requiredStr(b.leaveTypeId, 'leaveTypeId', 80)
    const type = await prisma.leaveType.findFirst({ where: { id: leaveTypeId, companyId: auth.companyId } })
    if (!type) throw notFound('Leave type')
    const f = policyFields(b, true)
    const rule = { method: f.method ?? 'per_hours_worked', rateHours: f.rateHours!, perHours: f.perHours ?? 40, carryoverMax: f.carryoverMax ?? null, waitingDays: f.waitingDays ?? 0 }
    await checkSickFloor(type.id, rule)
    const p = await prisma.leavePolicy.create({
      data: {
        companyId: auth.companyId,
        leaveTypeId: type.id,
        name: f.name!,
        ...rule,
        grantOn: f.grantOn ?? 'calendar',
        capHours: f.capHours ?? null,
        tiers: f.tiers ?? [],
        appliesToAll: f.appliesToAll ?? false,
      },
    })
    return { policy: policyView(p) }
  },
)

route(
  leaveRouter,
  { method: 'patch', path: '/leave/policies/:id', tag: 'Leave', summary: 'Change an accrual rule. Hours already earned stay as they are.', access: ['leave:write'], body: { name: 'Name', rateHours: 'Rate', capHours: 'Cap or null', carryoverMax: 'Carryover limit or null', waitingDays: 'Days', tiers: 'Tiers', active: 'false stops accrual' } },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const existing = await prisma.leavePolicy.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!existing) throw notFound('Leave policy')
    const f = policyFields(req.body ?? {}, false)
    await checkSickFloor(existing.leaveTypeId, {
      method: f.method ?? existing.method,
      rateHours: f.rateHours ?? existing.rateHours,
      perHours: f.perHours ?? existing.perHours,
      carryoverMax: f.carryoverMax === undefined ? existing.carryoverMax : f.carryoverMax,
      waitingDays: f.waitingDays ?? existing.waitingDays,
    })
    const p = await prisma.leavePolicy.update({ where: { id: existing.id }, data: f })
    return { policy: policyView(p) }
  },
)

// ─── A person's leave ───────────────────────────────────────────────────────

route(
  leaveRouter,
  { method: 'get', path: '/me/leave', tag: 'Leave', summary: 'Your balances, what you have asked for, and whether you have seen the sick-leave notice.', access: [SELF] },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const [leave, requests] = await Promise.all([
      personLeave(person),
      prisma.leaveRequest.findMany({ where: { personId: person.id }, include: leaveRequestInclude, orderBy: { startDate: 'desc' }, take: 50 }),
    ])
    return { ...leave, requests }
  },
)

route(
  leaveRouter,
  { method: 'post', path: '/me/leave/acknowledge-notice', tag: 'Leave', summary: 'Record that you have read the notice of your paid sick leave rights.', access: [SELF] },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    const saved = await prisma.person.update({ where: { id: person.id }, data: { sickNoticeAckAt: person.sickNoticeAckAt ?? new Date() } })
    return { acknowledgedAt: saved.sickNoticeAckAt }
  },
)

route(
  leaveRouter,
  { method: 'get', path: '/people/:id/leave', tag: 'Leave', summary: "A person's balances, policies and start date.", access: ['leave:read', SELF] },
  async (req) => {
    const auth = requireScope(req, 'leave:read', SELF)
    mayRead(auth, req.params.id)
    const person = await personIn(auth.companyId, req.params.id)
    const assignments = await prisma.personLeavePolicy.findMany({ where: { personId: person.id }, include: { policy: true }, orderBy: { effectiveFrom: 'desc' } })
    return {
      person: { id: person.id, name: person.name, email: person.email },
      ...(await personLeave(person)),
      assignments: assignments.map((a) => ({ id: a.id, leavePolicyId: a.leavePolicyId, policyName: a.policy.name, leaveTypeId: a.leaveTypeId, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo })),
    }
  },
)

route(
  leaveRouter,
  {
    method: 'put',
    path: '/people/:id/hire-date',
    tag: 'Leave',
    summary: "Set a person's first day of work. It decides when sick leave becomes usable and their years of service.",
    access: ['people:write', 'leave:write'],
    body: { hireDate: 'YYYY-MM-DD, or null to clear' },
  },
  async (req) => {
    const auth = requireScope(req, 'people:write', 'leave:write')
    const person = await personIn(auth.companyId, req.params.id)
    const raw = req.body?.hireDate
    const hireDate = raw === null || raw === '' ? null : ymd(raw, 'hireDate')
    const saved = await prisma.person.update({ where: { id: person.id }, data: { hireDate } })
    return { person: { id: saved.id, name: saved.name, hireDate: saved.hireDate } }
  },
)

route(
  leaveRouter,
  {
    method: 'put',
    path: '/people/:id/leave/policies',
    tag: 'Leave',
    summary: "Replace a person's individual policies (company-wide ones like Washington sick leave apply on their own).",
    access: ['leave:write'],
    body: { assignments: '[{ leavePolicyId, effectiveFrom: YYYY-MM-DD, effectiveTo?: YYYY-MM-DD }]' },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const person = await personIn(auth.companyId, req.params.id)
    const list: unknown[] = Array.isArray(req.body?.assignments) ? req.body.assignments : []
    if (list.length > 50) throw badRequest('50 assignments at most.')
    const policies = await prisma.leavePolicy.findMany({ where: { companyId: auth.companyId } })
    const rows = list.map((raw, i) => {
      const a = (raw ?? {}) as Record<string, unknown>
      const policy = policies.find((p) => p.id === str(a.leavePolicyId, 80))
      if (!policy) throw badRequest(`Assignment ${i + 1}: unknown leavePolicyId.`, { index: i })
      const effectiveFrom = ymd(a.effectiveFrom, `assignments[${i}].effectiveFrom`)
      const effectiveTo = a.effectiveTo === undefined || a.effectiveTo === null || a.effectiveTo === '' ? null : ymd(a.effectiveTo, `assignments[${i}].effectiveTo`)
      if (effectiveTo && effectiveTo < effectiveFrom) throw badRequest(`Assignment ${i + 1} ends before it starts.`, { index: i })
      return { companyId: auth.companyId, personId: person.id, leavePolicyId: policy.id, leaveTypeId: policy.leaveTypeId, effectiveFrom, effectiveTo }
    })
    // Two rules for the same kind of leave cannot cover the same day.
    for (const [i, a] of rows.entries()) {
      for (const b of rows.slice(i + 1)) {
        if (a.leaveTypeId !== b.leaveTypeId) continue
        const aEnd = a.effectiveTo ?? '9999-12-31'
        const bEnd = b.effectiveTo ?? '9999-12-31'
        if (a.effectiveFrom <= bEnd && b.effectiveFrom <= aEnd) throw conflict('policy_overlap', 'Two policies for the same kind of leave overlap in time. End one before the next starts.')
      }
    }
    await prisma.$transaction(async (tx) => {
      await tx.personLeavePolicy.deleteMany({ where: { personId: person.id } })
      if (rows.length) await tx.personLeavePolicy.createMany({ data: rows })
    })
    const saved = await prisma.personLeavePolicy.findMany({ where: { personId: person.id }, orderBy: { effectiveFrom: 'desc' } })
    return { assignments: saved }
  },
)

route(
  leaveRouter,
  {
    method: 'get',
    path: '/leave/ledger',
    tag: 'Leave',
    summary: 'Every accrual, use and adjustment, oldest first, with the running balance. Without leave:read you see only your own.',
    access: ['leave:read', SELF],
    query: { personId: 'Person (required with leave:read)', leaveTypeId: 'Only this kind of leave', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD', limit: 'Rows, 500 at most' },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:read', SELF)
    const personId = auth.scopes.has('leave:read') ? str(req.query.personId, 80) || requirePerson(auth).id : requirePerson(auth).id
    mayRead(auth, personId)
    const leaveTypeId = str(req.query.leaveTypeId, 80) || undefined
    const from = str(req.query.from, 10)
    const to = str(req.query.to, 10)
    const before = from
      ? await prisma.leaveLedger.groupBy({ by: ['leaveTypeId'], where: { personId, leaveTypeId, date: { lt: from } }, _sum: { hours: true } })
      : []
    const rows = await prisma.leaveLedger.findMany({
      where: { companyId: auth.companyId, personId, leaveTypeId, date: { gte: from || undefined, lte: to || undefined } },
      include: { leaveType: { select: { id: true, name: true } } },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
      take: limitOf(req.query.limit, 500, 2000),
    })
    const running = new Map(before.map((b) => [b.leaveTypeId, b._sum.hours ?? 0]))
    return {
      data: rows.map((r) => {
        const bal = roundHours((running.get(r.leaveTypeId) ?? 0) + r.hours)
        running.set(r.leaveTypeId, bal)
        return { ...r, balanceAfter: bal }
      }),
    }
  },
)

// ─── Requests ───────────────────────────────────────────────────────────────

/** Who the request is for: someone named (needs leave:write), else the caller. */
async function requester(req: Request, auth: Auth): Promise<Person> {
  const named = str(req.body?.personId, 80)
  if (named && named !== auth.person?.id) {
    requireScope(req, 'leave:write')
    return personIn(auth.companyId, named)
  }
  requireScope(req, SELF, 'leave:write')
  return requirePerson(auth)
}

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/requests',
    tag: 'Leave',
    summary: 'Ask for time off. It waits for a lead or manager to approve it.',
    access: [SELF, 'leave:write'],
    status: 201,
    body: {
      leaveTypeId: 'Kind of leave (required)',
      startDate: 'YYYY-MM-DD (required)',
      endDate: 'YYYY-MM-DD, inclusive. Defaults to startDate',
      hours: 'Hours of leave in total (required)',
      note: 'Optional note for the approver. Do not include medical details',
      personId: 'For someone else (needs leave:write)',
    },
  },
  async (req) => {
    const auth = requireAuth(req)
    const person = await requester(req, auth)
    const b = req.body ?? {}
    const startDate = ymd(b.startDate, 'startDate')
    const request = await createRequest(person, {
      leaveTypeId: requiredStr(b.leaveTypeId, 'leaveTypeId', 80),
      startDate,
      endDate: b.endDate ? ymd(b.endDate, 'endDate') : startDate,
      hours: hoursOf(b.hours, 'hours'),
      note: str(b.note, 500),
    })
    return { request }
  },
)

route(
  leaveRouter,
  {
    method: 'get',
    path: '/leave/requests',
    tag: 'Leave',
    summary: 'Time-off requests. Without leave:read you see only your own.',
    access: [SELF, 'leave:read'],
    query: { status: 'requested | approved | denied | cancelled', personId: 'Only this person', from: 'Requests ending on or after this date', to: 'Requests starting on or before this date', limit: 'Rows, 100 by default' },
  },
  async (req) => {
    const auth = requireScope(req, SELF, 'leave:read')
    const all = auth.scopes.has('leave:read')
    const from = str(req.query.from, 10)
    const to = str(req.query.to, 10)
    const rows = await prisma.leaveRequest.findMany({
      where: {
        companyId: auth.companyId,
        personId: all ? str(req.query.personId, 80) || undefined : requirePerson(auth).id,
        status: str(req.query.status, 20) || undefined,
        endDate: from ? { gte: from } : undefined,
        startDate: to ? { lte: to } : undefined,
      },
      include: leaveRequestInclude,
      orderBy: [{ startDate: 'asc' }, { createdAt: 'asc' }],
      take: limitOf(req.query.limit, 100, 500),
    })
    return { data: rows }
  },
)

for (const decision of ['approve', 'deny'] as const) {
  route(
    leaveRouter,
    {
      method: 'post',
      path: `/leave/requests/:id/${decision}`,
      tag: 'Leave',
      summary: decision === 'approve' ? 'Approve a request. The hours come off the balance.' : 'Deny a request, with a note saying why.',
      access: ['leave:approve'],
      body: { note: decision === 'approve' ? 'Optional note' : 'Why (required)' },
    },
    async (req) => {
      const auth = requireScope(req, 'leave:approve')
      return { request: await decideRequest(deciderOf(auth), req.params.id, decision, str(req.body?.note, 500)) }
    },
  )
}

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/requests/:id/cancel',
    tag: 'Leave',
    summary: 'Withdraw a request. Approved hours go back on the balance. A person can cancel their own approved time off only before it starts.',
    access: [SELF, 'leave:approve'],
    body: { note: 'Optional note' },
  },
  async (req) => {
    const auth = requireScope(req, SELF, 'leave:approve')
    return { request: await cancelRequest({ ...deciderOf(auth), personId: auth.person?.id ?? null, canApprove: auth.scopes.has('leave:approve') }, req.params.id, str(req.body?.note, 500)) }
  },
)

// ─── Balances: corrections, opening balances, accrual, year end ─────────────

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/adjustments',
    tag: 'Leave',
    summary: 'Correct a balance by hand. A reason is required and kept with the entry.',
    access: ['leave:write'],
    status: 201,
    body: {
      personId: 'Person (required)',
      leaveTypeId: 'Kind of leave (required)',
      hours: 'Hours to add, negative to take away (required)',
      date: 'YYYY-MM-DD the change counts on. Defaults to today',
      reason: 'Why (required)',
      kind: `${ADJUST_KINDS.join(' | ')}. Default adjustment; payout always takes hours away`,
    },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const b = req.body ?? {}
    const date = b.date ? ymd(b.date, 'date') : todayIn(await companyTz(auth.companyId))
    return adjust(auth.companyId, auth.via === 'session' ? auth.person?.id ?? null : null, {
      personId: requiredStr(b.personId, 'personId', 80),
      leaveTypeId: requiredStr(b.leaveTypeId, 'leaveTypeId', 80),
      hours: hoursOf(b.hours, 'hours', { allowNegative: true }),
      date,
      reason: str(b.reason, 500),
      kind: str(b.kind, 20) || 'adjustment',
    })
  },
)

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/opening-balances',
    tag: 'Leave',
    summary: 'Starting balances from a spreadsheet. Run with dryRun first to see each row matched; importing the same date twice does not double anything.',
    access: ['leave:write'],
    body: { date: 'YYYY-MM-DD the balances are as of (required)', rows: '[{ email, leaveType: key or name, hours }]', dryRun: 'true to check without saving' },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const b = req.body ?? {}
    const rows: OpeningRow[] = Array.isArray(b.rows) ? b.rows : []
    return importOpening(auth.companyId, auth.via === 'session' ? auth.person?.id ?? null : null, ymd(b.date, 'date'), rows, bool(b.dryRun) ?? false)
  },
)

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/accruals/run',
    tag: 'Leave',
    summary: 'Accrue leave from hours worked through a date. Runs on its own every night; running it again adds only what is missing.',
    access: ['leave:write'],
    body: { through: 'YYYY-MM-DD. Defaults to 8 days ago, so the week has had time for punch corrections' },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const tz = await companyTz(auth.companyId)
    const today = todayIn(tz)
    const through = req.body?.through ? ymd(req.body.through, 'through') : addDays(today, -8)
    if (through >= today) throw badRequest('through must be before today: today is not over yet.', { field: 'through' })
    return accrueThrough(auth.companyId, through, auth.via === 'session' ? auth.person?.id ?? null : null)
  },
)

route(
  leaveRouter,
  {
    method: 'post',
    path: '/leave/year-end',
    tag: 'Leave',
    summary: 'Apply carryover limits for a year that has ended. Runs on its own in January; running it again changes nothing.',
    access: ['leave:write'],
    body: { year: 'The year that ended, e.g. 2026' },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:write')
    const year = Number(req.body?.year)
    const today = todayIn(await companyTz(auth.companyId))
    if (!(`${year + 1}-01-01` <= today)) throw badRequest(`${year} has not ended yet.`, { field: 'year' })
    return yearEnd(auth.companyId, year, auth.via === 'session' ? auth.person?.id ?? null : null)
  },
)

// ─── Statements and reports ─────────────────────────────────────────────────

route(
  leaveRouter,
  {
    method: 'get',
    path: '/leave/statements',
    tag: 'Leave',
    summary: 'Monthly statement per person: opening, earned, used, other changes and closing balance. Washington requires one at least monthly for sick leave.',
    access: ['leave:read'],
    query: { month: 'YYYY-MM (required)', personId: 'Only this person' },
  },
  async (req) => {
    const auth = requireScope(req, 'leave:read')
    return statements(auth.companyId, assertMonth(req.query.month), str(req.query.personId, 80) || undefined)
  },
)

route(
  leaveRouter,
  { method: 'get', path: '/me/leave/statements', tag: 'Leave', summary: 'Your monthly statement.', access: [SELF], query: { month: 'YYYY-MM (required)' } },
  async (req) => {
    const auth = requireScope(req, SELF)
    return statements(auth.companyId, assertMonth(req.query.month), requirePerson(auth).id)
  },
)

route(
  leaveRouter,
  {
    method: 'get',
    path: '/reports/pfml-quarterly',
    tag: 'Views',
    summary: 'Hours per person in a calendar quarter, for the Washington Paid Family and Medical Leave report: hours worked, approved paid leave hours, and the two together. Payroll decides which to report.',
    access: ['reports:read', 'leave:read'],
    query: { year: 'e.g. 2026', quarter: '1-4' },
  },
  async (req) => {
    const auth = requireScope(req, 'reports:read', 'leave:read')
    const year = Number(req.query.year)
    const quarter = Number(req.query.quarter)
    if (!Number.isInteger(year) || year < 2000 || year > 2200) throw badRequest('year must be a year like 2026.', { field: 'year' })
    if (![1, 2, 3, 4].includes(quarter)) throw badRequest('quarter must be 1, 2, 3 or 4.', { field: 'quarter' })
    const tz = await companyTz(auth.companyId)
    const firstMonth = (quarter - 1) * 3 + 1
    const from = `${year}-${String(firstMonth).padStart(2, '0')}-01`
    const nextFrom = quarter === 4 ? `${year + 1}-01-01` : `${year}-${String(firstMonth + 3).padStart(2, '0')}-01`
    const to = addDays(nextFrom, -1)
    const [people, punches, leave] = await Promise.all([
      prisma.person.findMany({ where: { companyId: auth.companyId }, orderBy: { name: 'asc' } }),
      prisma.punch.findMany({
        where: { companyId: auth.companyId, clockIn: { gte: startOfLocalDay(from, tz), lt: startOfLocalDay(nextFrom, tz) }, clockOut: { not: null } },
        select: { personId: true, clockIn: true, clockOut: true },
      }),
      prisma.leaveRequest.findMany({
        where: { companyId: auth.companyId, status: 'approved', startDate: { gte: from, lte: to }, leaveType: { paid: true } },
        select: { personId: true, hours: true },
      }),
    ])
    const rows = people
      .map((p) => {
        const worked = roundHours(punches.filter((x) => x.personId === p.id).reduce((t, x) => t + hoursBetween(x.clockIn, x.clockOut), 0))
        const paidLeave = roundHours(leave.filter((x) => x.personId === p.id).reduce((t, x) => t + x.hours, 0))
        return { personId: p.id, name: p.name, email: p.email, hoursWorked: Math.round(worked * 100) / 100, paidLeaveHours: paidLeave, totalPaidHours: Math.round((worked + paidLeave) * 100) / 100 }
      })
      .filter((r) => r.hoursWorked || r.paidLeaveHours)
    return { year, quarter, from, to, rows }
  },
)

