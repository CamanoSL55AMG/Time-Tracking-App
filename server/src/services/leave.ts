import type { LeavePolicy, LeaveRequest, LeaveType, Person, Prisma } from '@prisma/client'
import { prisma, type Tx } from '../db.js'
import { config } from '../config.js'
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js'
import { addDays, isYmd, localDate, startOfLocalDay } from '../lib/time.js'
import { readSheet, type Rows } from '../lib/sheet.js'
import { emit } from './events.js'
import { laborExport } from './payroll.js'
import { weekOf } from './timesheets.js'
import { accruesLeave, workerTypeOn, type HasWorkerType, type WorkerType } from './workerType.js'
import {
  daysProblem,
  earnedInPeriod,
  expandDays,
  grantDatesIn,
  overCarryover,
  POLICY_METHODS,
  round2,
  sumHours,
  underCap,
  usableFrom,
  waSickProblems,
  WA_SICK_PRESET,
  yearsOfService,
  type LeaveDay,
  type PolicyRules,
} from './leaveRules.js'
import { buildRows, checkMapping, guessMapping, type ImportMapping } from './leaveImport.js'
import type { PersonFilter } from '../auth/division.js'

// Leave: balances kept as a ledger, Washington sick leave, vacation / PTO policies per
// person, time-off requests with approval, opening balances from the finance sheet,
// and leave hours for payroll and the board. TIME-TRACKING-APP.md §7.
// Everything here is off unless LEAVE_ENABLED=true.

export const LEAVE_OFF_MESSAGE = 'Leave tracking is turned off. Set LEAVE_ENABLED=true in server/.env and restart to turn it on.'

/** W-2 or 1099 on a day. With CONTRACTORS_ENABLED off, everyone is an employee. */
const typeOn = (p: HasWorkerType, date: string): WorkerType => (config.contractorsEnabled ? workerTypeOn(p, date) : 'employee')
const CONTRACTOR_NO_PAID_LEAVE = '1099 contractors get no paid leave. Use unpaid time off for days they are away.'

export function requireLeaveOn(): void {
  if (!config.leaveEnabled) throw new ApiError(403, 'leave_off', LEAVE_OFF_MESSAGE)
}

export interface LeaveActor {
  companyId: string
  personId: string | null
  apiKeyId: string | null
}

/** One writer per person at a time, so two approvals can't both spend the same hours. */
async function lockLeave(tx: Tx, personId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${'leave:' + personId}))::text`
}

const todayIn = async (companyId: string) => {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  return { company, today: localDate(new Date(), company.timezone) }
}

// ─── Setup: settings, types, the sick-leave preset ──────────────────────────

const SEPARATE_TYPES = [
  { key: 'sick', name: 'Sick leave', paid: true, drawsBalance: true, statutory: 'wa_sick', sortOrder: 10 },
  { key: 'vacation', name: 'Vacation', paid: true, drawsBalance: true, statutory: 'none', sortOrder: 20 },
]
const COMBINED_TYPES = [{ key: 'pto', name: 'PTO', paid: true, drawsBalance: true, statutory: 'wa_sick', sortOrder: 10 }]
const COMMON_TYPES = [
  { key: 'holiday', name: 'Holiday', paid: true, drawsBalance: false, statutory: 'none', sortOrder: 40 },
  { key: 'wa_pfml', name: 'WA Paid Family & Medical Leave', paid: false, drawsBalance: false, statutory: 'wa_pfml', sortOrder: 50 },
  { key: 'unpaid', name: 'Unpaid leave', paid: false, drawsBalance: false, statutory: 'none', sortOrder: 60 },
]

/** Make the company's leave settings, types and default policies the first time. Safe to repeat. */
export async function ensureLeaveSetup(companyId: string) {
  const settings =
    (await prisma.leaveSettings.findUnique({ where: { companyId } })) ??
    (await prisma.leaveSettings.upsert({ where: { companyId }, create: { companyId }, update: {} }))
  const wanted = [...(settings.banks === 'combined' ? COMBINED_TYPES : SEPARATE_TYPES), ...COMMON_TYPES]
  const have = await prisma.leaveType.findMany({ where: { companyId } })
  const haveKeys = new Set(have.map((t) => t.key))
  for (const t of wanted.filter((w) => !haveKeys.has(w.key))) {
    await prisma.leaveType.createMany({ data: [{ companyId, ...t }], skipDuplicates: true })
  }
  const types = await prisma.leaveType.findMany({ where: { companyId }, orderBy: { sortOrder: 'asc' } })
  const policies = await prisma.leavePolicy.findMany({ where: { companyId } })
  for (const t of types) {
    if (policies.some((p) => p.leaveTypeId === t.id)) continue
    if (t.statutory === 'wa_sick') {
      const { name, ...rules } = WA_SICK_PRESET
      await prisma.leavePolicy.create({ data: { companyId, leaveTypeId: t.id, name, ...rules, tiers: [] } })
    } else if (t.key === 'vacation') {
      // Morgan Sound's vacation rules are still to be set per person (open decision 8).
      await prisma.leavePolicy.create({ data: { companyId, leaveTypeId: t.id, name: 'Vacation (rate not set yet)', method: 'none', rateHours: 0, perHours: 40 } })
    }
  }
  return { settings, types }
}

// ─── Policies ───────────────────────────────────────────────────────────────

const asRules = (p: LeavePolicy): PolicyRules => ({
  method: p.method,
  rateHours: p.rateHours,
  perHours: p.perHours,
  periodHours: p.periodHours,
  grantOn: p.grantOn,
  tiers: p.tiers,
  balanceCap: p.balanceCap,
  carryoverMax: p.carryoverMax,
  waitingDays: p.waitingDays,
})

export interface PolicyInput {
  leaveTypeId?: string
  name?: string
  method?: string
  rateHours?: number
  perHours?: number
  periodHours?: number
  grantOn?: string
  tiers?: unknown
  balanceCap?: number | null
  carryoverMax?: number | null
  waitingDays?: number
  active?: boolean
}

function cleanPolicy(input: PolicyInput) {
  const out: Record<string, unknown> = {}
  if (input.name !== undefined) out.name = String(input.name).trim().slice(0, 120)
  if (input.method !== undefined) {
    if (!(POLICY_METHODS as readonly string[]).includes(input.method)) throw badRequest(`method must be ${POLICY_METHODS.join(', ')}.`, { field: 'method' })
    out.method = input.method
  }
  for (const k of ['rateHours', 'perHours', 'periodHours'] as const) {
    if (input[k] === undefined) continue
    const n = Number(input[k])
    if (!Number.isFinite(n) || n < 0 || n > 10_000) throw badRequest(`${k} must be a number of hours.`, { field: k })
    out[k] = n
  }
  if (input.grantOn !== undefined) {
    if (!['jan1', 'anniversary'].includes(input.grantOn)) throw badRequest('grantOn must be jan1 or anniversary.', { field: 'grantOn' })
    out.grantOn = input.grantOn
  }
  if (input.tiers !== undefined) {
    if (!Array.isArray(input.tiers)) throw badRequest('tiers must be a list.', { field: 'tiers' })
    out.tiers = input.tiers.slice(0, 20).map((t) => {
      const r = t as Record<string, unknown>
      const years = Number(r.years)
      if (!Number.isFinite(years) || years < 0) throw badRequest('Each tier needs years of service.', { field: 'tiers' })
      return {
        years,
        ...(r.rateHours !== undefined ? { rateHours: Number(r.rateHours) } : {}),
        ...(r.periodHours !== undefined ? { periodHours: Number(r.periodHours) } : {}),
      }
    }) as Prisma.InputJsonValue
  }
  for (const k of ['balanceCap', 'carryoverMax'] as const) {
    if (input[k] === undefined) continue
    if (input[k] === null) out[k] = null
    else {
      const n = Number(input[k])
      if (!Number.isFinite(n) || n < 0) throw badRequest(`${k} must be a number of hours, or empty for none.`, { field: k })
      out[k] = n
    }
  }
  if (input.waitingDays !== undefined) {
    const n = Number(input.waitingDays)
    if (!Number.isInteger(n) || n < 0 || n > 3650) throw badRequest('waitingDays must be a whole number of days.', { field: 'waitingDays' })
    out.waitingDays = n
  }
  if (input.active !== undefined) out.active = Boolean(input.active)
  return out
}

async function checkStatutory(type: LeaveType, rules: PolicyRules) {
  if (type.statutory !== 'wa_sick') return
  const problems = waSickProblems(rules)
  if (problems.length) throw badRequest(problems.join(' '), { problems })
}

export async function createPolicy(companyId: string, input: PolicyInput) {
  const type = await prisma.leaveType.findFirst({ where: { id: String(input.leaveTypeId ?? ''), companyId } })
  if (!type) throw notFound('Leave type')
  const data = cleanPolicy(input)
  if (!data.name) throw badRequest('Give the policy a name.', { field: 'name' })
  const defaults: PolicyRules = { method: 'per_hours_worked', rateHours: 1, perHours: 40, periodHours: 0, grantOn: 'jan1', tiers: [], balanceCap: null, carryoverMax: null, waitingDays: 0 }
  await checkStatutory(type, { ...defaults, ...data } as PolicyRules)
  return prisma.leavePolicy.create({ data: { companyId, leaveTypeId: type.id, name: String(data.name), ...data } as Prisma.LeavePolicyUncheckedCreateInput })
}

export async function updatePolicy(companyId: string, id: string, input: PolicyInput) {
  const policy = await prisma.leavePolicy.findFirst({ where: { id, companyId } })
  if (!policy) throw notFound('Policy')
  const type = await prisma.leaveType.findUniqueOrThrow({ where: { id: policy.leaveTypeId } })
  const data = cleanPolicy(input)
  await checkStatutory(type, { ...asRules(policy), ...data } as PolicyRules)
  return prisma.leavePolicy.update({ where: { id }, data })
}

/** Put a person on a policy for a leave type from a date. The one before it ends the day before. */
export async function assignPolicy(companyId: string, personId: string, leaveTypeId: string, leavePolicyId: string | null, effectiveFrom: string) {
  if (!isYmd(effectiveFrom)) throw badRequest('effectiveFrom must be a date, YYYY-MM-DD.', { field: 'effectiveFrom' })
  const person = await prisma.person.findFirst({ where: { id: personId, companyId } })
  if (!person) throw notFound('Person')
  const type = await prisma.leaveType.findFirst({ where: { id: leaveTypeId, companyId } })
  if (!type) throw notFound('Leave type')
  if (leavePolicyId) {
    const policy = await prisma.leavePolicy.findFirst({ where: { id: leavePolicyId, companyId, leaveTypeId } })
    if (!policy) throw badRequest('That policy is not for this leave type.', { field: 'leavePolicyId' })
  }
  return prisma.$transaction(async (tx) => {
    const current = await tx.personLeavePolicy.findMany({ where: { personId, leaveTypeId, OR: [{ effectiveTo: null }, { effectiveTo: { gte: effectiveFrom } }] } })
    for (const c of current) {
      if (c.effectiveFrom >= effectiveFrom) await tx.personLeavePolicy.update({ where: { id: c.id }, data: { effectiveTo: addDays(c.effectiveFrom, -1) } })
      else await tx.personLeavePolicy.update({ where: { id: c.id }, data: { effectiveTo: addDays(effectiveFrom, -1) } })
    }
    if (!leavePolicyId) return null
    return tx.personLeavePolicy.create({ data: { companyId, personId, leaveTypeId, leavePolicyId, effectiveFrom } })
  })
}

/**
 * The policy a person is on for a leave type on a date. An assignment wins; without
 * one, Washington sick leave (or the combined PTO bank) falls back to the company's
 * sick-leave policy, since every employee is covered. Other types need an assignment.
 */
async function policiesOn(companyId: string, date: string) {
  const [types, policies, assigned] = await Promise.all([
    prisma.leaveType.findMany({ where: { companyId, active: true } }),
    prisma.leavePolicy.findMany({ where: { companyId } }),
    prisma.personLeavePolicy.findMany({ where: { companyId, effectiveFrom: { lte: date }, OR: [{ effectiveTo: null }, { effectiveTo: { gte: date } }] } }),
  ])
  const policyById = new Map(policies.map((p) => [p.id, p]))
  const fallback = new Map<string, LeavePolicy>()
  for (const t of types) {
    if (t.statutory !== 'wa_sick') continue
    const p = policies.filter((x) => x.leaveTypeId === t.id && x.active).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
    if (p) fallback.set(t.id, p)
  }
  const explicit = new Map(assigned.map((a) => [`${a.personId}|${a.leaveTypeId}`, policyById.get(a.leavePolicyId)]))
  return {
    types,
    policyFor(personId: string, leaveTypeId: string): LeavePolicy | null {
      const key = `${personId}|${leaveTypeId}`
      if (explicit.has(key)) return explicit.get(key) ?? null
      return fallback.get(leaveTypeId) ?? null
    },
    assignedPeople: (leaveTypeId: string) => assigned.filter((a) => a.leaveTypeId === leaveTypeId).map((a) => a.personId),
  }
}

// ─── Balances ───────────────────────────────────────────────────────────────

export interface Balance {
  personId: string
  leaveTypeId: string
  /** Sum of every ledger entry (approved future days already taken off). */
  balance: number
  /** Hours in requests still waiting for a decision. */
  pending: number
  /** What can still be asked for: balance less pending. */
  available: number
  /** Approved days still to come. */
  booked: number
}

export async function balancesFor(companyId: string, personIds?: string[], today?: string): Promise<Balance[]> {
  const day = today ?? (await todayIn(companyId)).today
  const where = { companyId, ...(personIds ? { personId: { in: personIds } } : {}) }
  const [sums, future, pending] = await Promise.all([
    prisma.leaveLedger.groupBy({ by: ['personId', 'leaveTypeId'], where, _sum: { hours: true } }),
    prisma.leaveLedger.groupBy({ by: ['personId', 'leaveTypeId'], where: { ...where, kind: 'use', date: { gt: day } }, _sum: { hours: true } }),
    prisma.leaveRequest.groupBy({ by: ['personId', 'leaveTypeId'], where: { ...where, status: 'pending' }, _sum: { hours: true } }),
  ])
  const out = new Map<string, Balance>()
  const get = (personId: string, leaveTypeId: string) => {
    const k = `${personId}|${leaveTypeId}`
    let b = out.get(k)
    if (!b) out.set(k, (b = { personId, leaveTypeId, balance: 0, pending: 0, available: 0, booked: 0 }))
    return b
  }
  for (const s of sums) get(s.personId, s.leaveTypeId).balance = round2(s._sum.hours ?? 0)
  for (const s of future) get(s.personId, s.leaveTypeId).booked = round2(-(s._sum.hours ?? 0))
  for (const s of pending) get(s.personId, s.leaveTypeId).pending = round2(s._sum.hours ?? 0)
  for (const b of out.values()) b.available = round2(b.balance - b.pending)
  return [...out.values()]
}

async function balanceOf(tx: Tx, personId: string, leaveTypeId: string, opts: { excludeRef?: string } = {}) {
  const s = await tx.leaveLedger.aggregate({
    where: { personId, leaveTypeId, ...(opts.excludeRef ? { sourceRef: { not: opts.excludeRef } } : {}) },
    _sum: { hours: true },
  })
  return round2(s._sum.hours ?? 0)
}

// ─── Profiles (hire date, notice of rights) ─────────────────────────────────

export async function setProfile(companyId: string, personId: string, input: { hireDate?: string | null }) {
  const person = await prisma.person.findFirst({ where: { id: personId, companyId } })
  if (!person) throw notFound('Person')
  const hireDate = input.hireDate === undefined ? undefined : input.hireDate || null
  if (hireDate && !isYmd(hireDate)) throw badRequest('hireDate must be a date, YYYY-MM-DD.', { field: 'hireDate' })
  return prisma.leaveProfile.upsert({ where: { personId }, create: { personId, companyId, hireDate: hireDate ?? null }, update: { hireDate } })
}

export async function acknowledgeNotice(person: Person) {
  return prisma.leaveProfile.upsert({
    where: { personId: person.id },
    create: { personId: person.id, companyId: person.companyId, noticeAckAt: new Date() },
    update: { noticeAckAt: new Date() },
  })
}

// ─── Requests ───────────────────────────────────────────────────────────────

export interface RequestInput {
  personId: string
  leaveTypeId: string
  startDate: string
  endDate?: string
  hoursPerDay?: number
  includeWeekends?: boolean
  days?: LeaveDay[]
  note?: string
}

const isApprover = (scopes: Set<string>) => scopes.has('leave:approve')

/**
 * Ask for time off, for yourself; or, as an approver, record leave for someone else
 * (a state family-leave period, a call-in sick day), optionally approving it at once.
 */
export async function createLeaveRequest(actor: LeaveActor, scopes: Set<string>, input: RequestInput, approveNow = false) {
  const self = input.personId === actor.personId
  if (!self && !isApprover(scopes)) throw forbidden('You can ask for your own time off only.')
  if (approveNow && (self || !isApprover(scopes))) throw forbidden('Someone else has to approve your own leave.')
  const person = await prisma.person.findFirst({ where: { id: input.personId, companyId: actor.companyId } })
  if (!person) throw notFound('Person')
  const type = await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, companyId: actor.companyId, active: true } })
  if (!type) throw notFound('Leave type')

  const start = input.startDate
  const end = input.endDate || input.startDate
  const days = input.days?.length
    ? input.days.map((d) => ({ date: String(d.date), hours: Number(d.hours) }))
    : expandDays(start, end, input.hoursPerDay ?? 8, Boolean(input.includeWeekends))
  const problem = daysProblem(days, start, end)
  if (problem) throw badRequest(problem, { field: 'days' })
  const hours = sumHours(days)
  if (type.paid && days.some((d) => !accruesLeave(typeOn(person, d.date)))) throw badRequest(CONTRACTOR_NO_PAID_LEAVE, { field: 'leaveTypeId' })
  if (hours <= 0 && type.drawsBalance) throw badRequest('Ask for at least some hours.', { field: 'hoursPerDay' })

  // Washington sick leave: usable from the 90th day after hire.
  const { today } = await todayIn(actor.companyId)
  const { policyFor } = await policiesOn(actor.companyId, start)
  const policy = policyFor(person.id, type.id)
  const profile = await prisma.leaveProfile.findUnique({ where: { personId: person.id } })
  const from = usableFrom(profile?.hireDate, policy?.waitingDays ?? 0)
  if (from && start < from) throw conflict('leave_waiting_period', `${type.name} can be used from ${from}, 90 days after the start date.`, { usableFrom: from })

  // No reason is ever stored for sick leave (§7.2): the note is dropped.
  const note = type.statutory === 'wa_sick' ? '' : String(input.note ?? '').trim().slice(0, 300)

  return prisma.$transaction(async (tx) => {
    await lockLeave(tx, person.id)
    const overlap = await tx.leaveRequest.findFirst({
      where: { personId: person.id, status: { in: ['pending', 'approved'] }, startDate: { lte: end }, endDate: { gte: start } },
    })
    if (overlap) {
      const taken = new Set((overlap.days as unknown as LeaveDay[]).map((d) => d.date))
      const clash = days.find((d) => taken.has(d.date))
      if (clash) throw conflict('leave_overlap', `${clash.date} is already in another leave request.`, { requestId: overlap.id })
    }
    if (type.drawsBalance) {
      const balance = await balanceOf(tx, person.id, type.id)
      const waiting = await tx.leaveRequest.aggregate({ where: { personId: person.id, leaveTypeId: type.id, status: 'pending' }, _sum: { hours: true } })
      const available = round2(balance - (waiting._sum.hours ?? 0))
      if (hours > available + 1e-9) {
        throw conflict('leave_balance_short', `That is ${hours} hours; ${available} hours of ${type.name.toLowerCase()} are available.`, { available, hours })
      }
    }
    const req = await tx.leaveRequest.create({
      data: {
        companyId: actor.companyId,
        personId: person.id,
        leaveTypeId: type.id,
        startDate: start,
        endDate: end,
        days: days as unknown as Prisma.InputJsonValue,
        hours,
        note,
        requestedById: actor.personId ?? person.id,
      },
    })
    await emit(tx, actor.companyId, 'leave.requested', { id: req.id, personId: person.id, leaveTypeId: type.id, startDate: start, endDate: end, hours })
    if (!approveNow) return req
    return approveTx(tx, actor, req, type, today, '')
  })
}

async function approveTx(tx: Tx, actor: LeaveActor, req: LeaveRequest, type: LeaveType, today: string, note: string) {
  if (type.drawsBalance) {
    const balance = await balanceOf(tx, req.personId, type.id)
    if (req.hours > balance + 1e-9) {
      throw conflict('leave_balance_short', `That is ${req.hours} hours; the ${type.name.toLowerCase()} balance is ${balance} hours.`, { balance, hours: req.hours })
    }
    const rows = (req.days as unknown as LeaveDay[]).filter((d) => d.hours > 0)
    await tx.leaveLedger.createMany({
      data: rows.map((d) => ({
        companyId: req.companyId,
        personId: req.personId,
        leaveTypeId: type.id,
        kind: 'use',
        hours: -d.hours,
        date: d.date,
        sourceRef: `request:${req.id}`,
        note: type.statutory === 'wa_sick' ? type.name : '',
        createdById: actor.personId,
      })),
    })
  }
  const u = await tx.leaveRequest.update({ where: { id: req.id }, data: { status: 'approved', decidedById: actor.personId, decidedAt: new Date(), decisionNote: note } })
  await emit(tx, req.companyId, 'leave.approved', { id: req.id, personId: req.personId, leaveTypeId: type.id, startDate: req.startDate, endDate: req.endDate, hours: req.hours, today })
  return u
}

/** Approve or deny. Nobody approves their own leave, whatever their role. */
export async function decideLeaveRequest(actor: LeaveActor, id: string, decision: 'approve' | 'deny', note: string) {
  const req = await prisma.leaveRequest.findFirst({ where: { id, companyId: actor.companyId } })
  if (!req) throw notFound('Leave request')
  if (req.status !== 'pending') throw conflict('leave_decided', 'This request has already been decided.')
  if (actor.personId && req.personId === actor.personId) throw conflict('own_leave', 'Someone else has to approve your own leave.')
  const type = await prisma.leaveType.findUniqueOrThrow({ where: { id: req.leaveTypeId } })
  const { today } = await todayIn(actor.companyId)
  return prisma.$transaction(async (tx) => {
    await lockLeave(tx, req.personId)
    const fresh = await tx.leaveRequest.findUniqueOrThrow({ where: { id } })
    if (fresh.status !== 'pending') throw conflict('leave_decided', 'This request has already been decided.')
    if (decision === 'approve') return approveTx(tx, actor, fresh, type, today, note.trim().slice(0, 300))
    if (!note.trim()) throw badRequest('Say why, so the person knows what to do.', { field: 'note' })
    const u = await tx.leaveRequest.update({ where: { id }, data: { status: 'denied', decidedById: actor.personId, decidedAt: new Date(), decisionNote: note.trim().slice(0, 300) } })
    await emit(tx, actor.companyId, 'leave.denied', { id, personId: req.personId })
    return u
  })
}

/**
 * Withdraw a request. The person can withdraw their own while it waits, or approved
 * leave that hasn't started. An approver can cancel approved leave at any time; the
 * hours go back on the balance with a matching entry.
 */
export async function cancelLeaveRequest(actor: LeaveActor, scopes: Set<string>, id: string, note: string) {
  const req = await prisma.leaveRequest.findFirst({ where: { id, companyId: actor.companyId } })
  if (!req) throw notFound('Leave request')
  const own = req.personId === actor.personId
  const { today } = await todayIn(actor.companyId)
  if (!own && !isApprover(scopes)) throw forbidden('That is not your request.')
  if (req.status !== 'pending' && req.status !== 'approved') throw conflict('leave_decided', 'This request is already closed.')
  if (req.status === 'approved' && !isApprover(scopes) && req.startDate <= today) {
    throw conflict('leave_started', 'This leave has started. Ask your supervisor to change it.')
  }
  if (req.status === 'approved' && own && isApprover(scopes) && req.startDate <= today) {
    throw conflict('own_leave', 'Someone else has to change leave of yours that has started.')
  }
  return prisma.$transaction(async (tx) => {
    await lockLeave(tx, req.personId)
    const fresh = await tx.leaveRequest.findUniqueOrThrow({ where: { id } })
    if (fresh.status === 'approved') {
      const used = await tx.leaveLedger.findMany({ where: { personId: req.personId, sourceRef: `request:${id}` } })
      if (used.length) {
        await tx.leaveLedger.createMany({
          data: used.map((u) => ({
            companyId: u.companyId,
            personId: u.personId,
            leaveTypeId: u.leaveTypeId,
            kind: 'use',
            hours: -u.hours,
            date: u.date,
            sourceRef: `request:${id}:cancel`,
            note: 'Leave cancelled',
            createdById: actor.personId,
          })),
        })
      }
    } else if (fresh.status !== 'pending') throw conflict('leave_decided', 'This request is already closed.')
    const u = await tx.leaveRequest.update({
      where: { id },
      data: { status: 'cancelled', decidedById: own ? fresh.decidedById : actor.personId, decidedAt: new Date(), decisionNote: note.trim().slice(0, 300) || fresh.decisionNote },
    })
    await emit(tx, actor.companyId, 'leave.cancelled', { id, personId: req.personId, wasApproved: fresh.status === 'approved' })
    return u
  })
}

export async function listLeaveRequests(companyId: string, opts: { status?: string; personId?: PersonFilter; from?: string; to?: string; limit?: number }) {
  const rows = await prisma.leaveRequest.findMany({
    where: {
      companyId,
      status: opts.status || undefined,
      personId: opts.personId || undefined,
      ...(opts.from ? { endDate: { gte: opts.from } } : {}),
      ...(opts.to ? { startDate: { lte: opts.to } } : {}),
    },
    orderBy: opts.status === 'pending' ? { createdAt: 'asc' } : { startDate: 'desc' },
    take: opts.limit ?? 200,
  })
  return viewRequests(rows)
}

export async function viewRequests(rows: LeaveRequest[]) {
  const ids = [...new Set(rows.flatMap((r) => [r.personId, r.requestedById, r.decidedById]).filter((x): x is string => Boolean(x)))]
  const typeIds = [...new Set(rows.map((r) => r.leaveTypeId))]
  const [people, types] = await Promise.all([
    prisma.person.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }),
    prisma.leaveType.findMany({ where: { id: { in: typeIds } } }),
  ])
  const name = new Map(people.map((p) => [p.id, p.name]))
  const type = new Map(types.map((t) => [t.id, t]))
  return rows.map((r) => ({
    id: r.id,
    person: { id: r.personId, name: name.get(r.personId) ?? '' },
    leaveType: { id: r.leaveTypeId, key: type.get(r.leaveTypeId)?.key ?? '', name: type.get(r.leaveTypeId)?.name ?? '' },
    startDate: r.startDate,
    endDate: r.endDate,
    days: r.days as unknown as LeaveDay[],
    hours: r.hours,
    note: r.note,
    status: r.status as 'pending' | 'approved' | 'denied' | 'cancelled',
    requestedBy: name.get(r.requestedById) ?? '',
    decidedBy: r.decidedById ? name.get(r.decidedById) ?? '' : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt,
  }))
}

// ─── Adjustments ────────────────────────────────────────────────────────────

export async function addAdjustment(
  actor: LeaveActor,
  input: { personId: string; leaveTypeId: string; hours: number; date?: string; kind?: string; note: string },
) {
  const note = String(input.note ?? '').trim().slice(0, 300)
  if (!note) throw badRequest('Say why the balance is changing.', { field: 'note' })
  const kind = input.kind || 'adjustment'
  if (!['adjustment', 'payout', 'reinstate', 'carryover', 'forfeit'].includes(kind)) {
    throw badRequest('kind must be adjustment, payout, reinstate, carryover or forfeit. Accrual and use come from hours and requests.', { field: 'kind' })
  }
  const hours = round2(Number(input.hours))
  if (!Number.isFinite(hours) || hours === 0 || Math.abs(hours) > 10_000) throw badRequest('hours must be a non-zero number (minus to take hours off).', { field: 'hours' })
  if ((kind === 'payout' || kind === 'forfeit') && hours > 0) throw badRequest(`A ${kind} takes hours off: give a negative number.`, { field: 'hours' })
  if (kind === 'reinstate' && hours < 0) throw badRequest('A reinstatement adds hours: give a positive number.', { field: 'hours' })
  const person = await prisma.person.findFirst({ where: { id: input.personId, companyId: actor.companyId } })
  if (!person) throw notFound('Person')
  if (actor.personId && person.id === actor.personId) throw forbidden('Someone else has to change your own balance.')
  const type = await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, companyId: actor.companyId } })
  if (!type) throw notFound('Leave type')
  if (!type.drawsBalance) throw badRequest(`${type.name} has no balance.`, { field: 'leaveTypeId' })
  if (kind === 'payout' && type.statutory === 'wa_sick') {
    const settings = await prisma.leaveSettings.findUnique({ where: { companyId: actor.companyId } })
    if (!settings?.sickPayoutAtSeparation) throw conflict('sick_payout_off', 'Paying out sick leave is turned off for this company.')
  }
  const { today } = await todayIn(actor.companyId)
  const date = input.date || today
  if (!isYmd(date)) throw badRequest('date must be YYYY-MM-DD.', { field: 'date' })
  return prisma.$transaction(async (tx) => {
    await lockLeave(tx, person.id)
    const row = await tx.leaveLedger.create({
      data: { companyId: actor.companyId, personId: person.id, leaveTypeId: type.id, kind, hours, date, sourceRef: 'manual', note, createdById: actor.personId },
    })
    await emit(tx, actor.companyId, 'leave.adjusted', { id: row.id, personId: person.id, leaveTypeId: type.id, kind, hours, date })
    return row
  })
}

export async function ledger(companyId: string, opts: { personId?: PersonFilter; leaveTypeId?: string; from?: string; to?: string; limit?: number }) {
  const rows = await prisma.leaveLedger.findMany({
    where: {
      companyId,
      personId: opts.personId || undefined,
      leaveTypeId: opts.leaveTypeId || undefined,
      ...(opts.from || opts.to ? { date: { ...(opts.from ? { gte: opts.from } : {}), ...(opts.to ? { lte: opts.to } : {}) } } : {}),
    },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    take: opts.limit ?? 1000,
  })
  return rows
}

// ─── Accrual ────────────────────────────────────────────────────────────────

export interface AccrualResult {
  from: string
  to: string
  countedFrom: string
  people: {
    personId: string
    personName: string
    hoursWorked: number
    skipped?: string
    accruals: { leaveTypeId: string; policyId: string; earned: number; posted: number; total: number; note?: string }[]
  }[]
  notReady: { personId: string; personName: string; weekStart: string; status: string; hours: number }[]
  posted: number
}

/**
 * Earn leave for a pay period from approved hours (every hour worked, overtime and
 * travel included). Safe to run again: each policy's accrual for the period is
 * brought to what the hours earn now, so a week approved late or corrected adds the
 * difference. Hours before the switchover day are left out (the opening balance
 * already holds them). 1099 contractors earn nothing.
 */
export async function runAccrual(actor: LeaveActor, from: string, to: string, opts: { dryRun?: boolean } = {}): Promise<AccrualResult> {
  if (!isYmd(from) || !isYmd(to) || to < from) throw badRequest('from and to must be dates, YYYY-MM-DD, with to on or after from.')
  const { today } = await todayIn(actor.companyId)
  if (to >= today) throw badRequest('Run accrual for a pay period that is over.', { field: 'to' })
  await ensureLeaveSetup(actor.companyId)
  const settings = await prisma.leaveSettings.findUniqueOrThrow({ where: { companyId: actor.companyId } })
  const countedFrom = settings.switchoverDate && settings.switchoverDate > from ? settings.switchoverDate : from
  const { types, policyFor, assignedPeople } = await policiesOn(actor.companyId, to)

  const worked = new Map<string, number>()
  let notReady: AccrualResult['notReady'] = []
  if (countedFrom <= to) {
    const labor = await laborExport(actor.companyId, countedFrom, to, { contractors: config.contractorsEnabled })
    // Only W-2 days earn leave: hours on a day the person was a 1099 contractor don't count.
    for (const l of labor.lines) {
      if (!accruesLeave(l.workerType ?? 'employee')) continue
      worked.set(l.personId, (worked.get(l.personId) ?? 0) + l.hours)
    }
    notReady = labor.notReady.map(({ personId, personName, weekStart, status, hours }) => ({ personId, personName, weekStart, status, hours }))
  }

  const balanceTypes = types.filter((t) => t.drawsBalance)
  // Anyone already credited for this period is looked at again, so a correction (a week
  // reopened, someone found to be a 1099 contractor) takes the credit back.
  const credited = await prisma.leaveLedger.findMany({
    where: { companyId: actor.companyId, kind: 'accrual', sourceRef: { endsWith: `:${from}:${to}`, startsWith: 'accrual:' } },
    select: { personId: true },
    distinct: ['personId'],
  })
  const candidates = new Set<string>([...worked.keys(), ...balanceTypes.flatMap((t) => assignedPeople(t.id)), ...credited.map((c) => c.personId)])
  const people = await prisma.person.findMany({ where: { companyId: actor.companyId, id: { in: [...candidates] } } })
  const profiles = new Map((await prisma.leaveProfile.findMany({ where: { personId: { in: people.map((p) => p.id) } } })).map((p) => [p.personId, p]))

  const result: AccrualResult = { from, to, countedFrom, people: [], notReady, posted: 0 }
  for (const person of people.sort((a, b) => a.name.localeCompare(b.name))) {
    const hoursWorked = round2(worked.get(person.id) ?? 0)
    const entry: AccrualResult['people'][number] = { personId: person.id, personName: person.name, hoursWorked, accruals: [] }
    result.people.push(entry)
    // A 1099 contractor earns nothing; someone who was an employee for part of the period
    // earns on those hours only (above). Their writes still run, at zero, so credit
    // given before the type was set is taken back.
    const contractorNow = !accruesLeave(typeOn(person, to))
    if (contractorNow && hoursWorked === 0) entry.skipped = '1099 contractors earn no leave.'
    const hireDate = profiles.get(person.id)?.hireDate
    const years = yearsOfService(hireDate, to)
    for (const type of balanceTypes) {
      const policy = policyFor(person.id, type.id)
      if (!policy || !policy.active || policy.method === 'none') continue
      const rules = asRules(policy)
      const writes: { ref: string; target: number; date: string }[] = []
      if (policy.method === 'per_hours_worked' || policy.method === 'per_period') {
        const eligible = policy.method === 'per_hours_worked' || (assignedPeople(type.id).includes(person.id) && person.active && !contractorNow)
        writes.push({ ref: `accrual:${policy.id}:${from}:${to}`, target: eligible ? earnedInPeriod(rules, hoursWorked, years) : 0, date: to })
      }
      for (const day of grantDatesIn(rules, hireDate, countedFrom, to)) {
        const target = accruesLeave(typeOn(person, day)) ? earnedInPeriod({ ...rules, method: 'per_period' }, 0, yearsOfService(hireDate, day)) : 0
        writes.push({ ref: `grant:${policy.id}:${day}`, target, date: day })
      }
      for (const w of writes) {
        const outcome = await prisma.$transaction(async (tx) => {
          await lockLeave(tx, person.id)
          const before = await balanceOf(tx, person.id, type.id, { excludeRef: w.ref })
          const already = await tx.leaveLedger.aggregate({ where: { personId: person.id, leaveTypeId: type.id, sourceRef: w.ref }, _sum: { hours: true } })
          const have = round2(already._sum.hours ?? 0)
          const target = underCap(w.target, before, policy.balanceCap)
          const delta = round2(target - have)
          if (!opts.dryRun && Math.abs(delta) >= 0.01) {
            await tx.leaveLedger.create({
              data: {
                companyId: actor.companyId,
                personId: person.id,
                leaveTypeId: type.id,
                kind: 'accrual',
                hours: delta,
                date: w.date,
                sourceRef: w.ref,
                note: w.ref.startsWith('grant:') ? `${policy.name}: grant` : `${policy.name}: ${hoursWorked} h worked ${countedFrom} to ${to}${have ? ' (recalculated)' : ''}`,
                createdById: actor.personId,
              },
            })
          }
          return { earned: w.target, posted: Math.abs(delta) >= 0.01 ? delta : 0, total: target, capped: target < w.target }
        })
        if (outcome.posted) result.posted += 1
        if (!outcome.earned && !outcome.posted && !outcome.total) continue
        entry.accruals.push({ leaveTypeId: type.id, policyId: policy.id, earned: outcome.earned, posted: outcome.posted, total: outcome.total, ...(outcome.capped ? { note: 'Stopped at the balance cap.' } : {}) })
      }
    }
  }
  if (!opts.dryRun && result.posted) {
    await prisma.$transaction((tx) => emit(tx, actor.companyId, 'leave.accrued', { from, to, entries: result.posted }))
  }
  return result
}

/** Dec 31: anything over a policy's carryover limit is forfeited. Safe to run again. */
export async function runYearEnd(actor: LeaveActor, year: number, opts: { dryRun?: boolean } = {}) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw badRequest('year must be a year, e.g. 2026.', { field: 'year' })
  const end = `${year}-12-31`
  const { today } = await todayIn(actor.companyId)
  if (today <= end) throw badRequest(`Run the year end for ${year} once the year is over.`, { field: 'year' })
  const { types, policyFor } = await policiesOn(actor.companyId, end)
  const out: { personId: string; personName: string; leaveTypeId: string; balance: number; carryoverMax: number; forfeited: number }[] = []
  const sums = await prisma.leaveLedger.groupBy({ by: ['personId', 'leaveTypeId'], where: { companyId: actor.companyId, date: { lte: end } }, _sum: { hours: true } })
  const names = new Map((await prisma.person.findMany({ where: { companyId: actor.companyId }, select: { id: true, name: true } })).map((p) => [p.id, p.name]))
  for (const s of sums) {
    const type = types.find((t) => t.id === s.leaveTypeId)
    if (!type) continue
    const policy = policyFor(s.personId, s.leaveTypeId)
    if (!policy || policy.carryoverMax === null) continue
    const ref = `year-end:${year}:${policy.id}`
    const done = await prisma.leaveLedger.findFirst({ where: { personId: s.personId, leaveTypeId: s.leaveTypeId, sourceRef: ref } })
    if (done) continue
    const balance = round2(s._sum.hours ?? 0)
    const forfeit = overCarryover(balance, policy.carryoverMax)
    if (!forfeit) continue
    out.push({ personId: s.personId, personName: names.get(s.personId) ?? '', leaveTypeId: s.leaveTypeId, balance, carryoverMax: policy.carryoverMax, forfeited: forfeit })
    if (!opts.dryRun) {
      await prisma.leaveLedger.create({
        data: { companyId: actor.companyId, personId: s.personId, leaveTypeId: s.leaveTypeId, kind: 'forfeit', hours: -forfeit, date: end, sourceRef: ref, note: `Over the ${policy.carryoverMax} h carryover at year end`, createdById: actor.personId },
      })
    }
  }
  return { year, dryRun: Boolean(opts.dryRun), forfeits: out }
}

// ─── Statements, payroll, board, state report ───────────────────────────────

/** Monthly statement (WA requires one at least monthly): earned, used and available per type. */
export async function statements(companyId: string, month: string, personId?: PersonFilter) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('month must be YYYY-MM.', { field: 'month' })
  const first = `${month}-01`
  const [y, m] = month.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
  const [types, people, rows] = await Promise.all([
    prisma.leaveType.findMany({ where: { companyId, drawsBalance: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.person.findMany({ where: { companyId, ...(personId ? { id: personId } : {}) }, orderBy: { name: 'asc' } }),
    prisma.leaveLedger.findMany({ where: { companyId, date: { lte: last }, ...(personId ? { personId } : {}) } }),
  ])
  const out = []
  for (const p of people) {
    const lines = types.map((t) => {
      const mine = rows.filter((r) => r.personId === p.id && r.leaveTypeId === t.id)
      const opening = round2(mine.filter((r) => r.date < first).reduce((s, r) => s + r.hours, 0))
      const inMonth = mine.filter((r) => r.date >= first)
      const earned = round2(inMonth.filter((r) => r.kind === 'accrual').reduce((s, r) => s + r.hours, 0))
      const used = round2(-inMonth.filter((r) => r.kind === 'use').reduce((s, r) => s + r.hours, 0))
      const other = round2(inMonth.filter((r) => r.kind !== 'accrual' && r.kind !== 'use').reduce((s, r) => s + r.hours, 0))
      return { leaveTypeId: t.id, leaveType: t.name, opening, earned, used, other, available: round2(opening + earned - used + other) }
    })
    if (!personId && lines.every((l) => !l.opening && !l.earned && !l.used && !l.other)) continue
    out.push({ personId: p.id, personName: p.name, personEmail: p.email, month, from: first, to: last, lines })
  }
  return { month, statements: out }
}

export interface LeaveLine {
  lineId: string
  requestId: string
  personId: string
  personEmail: string
  personName: string
  date: string
  weekStart: string
  leaveTypeKey: string
  leaveTypeName: string
  hours: number
}

/**
 * Approved paid leave for payroll, one line per person per day per type. Paid at the
 * normal rate in the period it was used; it is not hours worked, so it never counts
 * toward overtime. Unpaid types (state family leave, unpaid) stay out.
 */
export async function leaveForPayroll(companyId: string, from: string, to: string, personId?: PersonFilter) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const [requests, types] = await Promise.all([
    prisma.leaveRequest.findMany({ where: { companyId, ...(personId ? { personId } : {}), status: { in: ['approved', 'pending'] }, startDate: { lte: to }, endDate: { gte: from } } }),
    prisma.leaveType.findMany({ where: { companyId } }),
  ])
  const type = new Map(types.map((t) => [t.id, t]))
  const people = new Map((await prisma.person.findMany({ where: { id: { in: [...new Set(requests.map((r) => r.personId))] } } })).map((p) => [p.id, p]))
  const lines: LeaveLine[] = []
  const pending: { requestId: string; personId: string; personName: string; leaveType: string; startDate: string; endDate: string; hours: number }[] = []
  for (const r of requests) {
    const t = type.get(r.leaveTypeId)
    const p = people.get(r.personId)
    if (!t || !p || !t.paid) continue
    const days = (r.days as unknown as LeaveDay[]).filter((d) => d.date >= from && d.date <= to && d.hours > 0 && accruesLeave(typeOn(p, d.date)))
    if (!days.length) continue
    if (r.status === 'pending') {
      pending.push({ requestId: r.id, personId: p.id, personName: p.name, leaveType: t.name, startDate: r.startDate, endDate: r.endDate, hours: sumHours(days) })
      continue
    }
    for (const d of days) {
      lines.push({
        lineId: `leave-${r.id.slice(0, 8)}-${d.date}`,
        requestId: r.id,
        personId: p.id,
        personEmail: p.email,
        personName: p.name,
        date: d.date,
        weekStart: weekOf(d.date, company.weekStartDay),
        leaveTypeKey: t.key,
        leaveTypeName: t.name,
        hours: round2(d.hours),
      })
    }
  }
  lines.sort((a, b) => a.personName.localeCompare(b.personName) || a.date.localeCompare(b.date))
  return { lines, pending }
}

/** Who is off on a day, for the board. */
export async function offOn(companyId: string, date: string) {
  const reqs = await prisma.leaveRequest.findMany({ where: { companyId, status: 'approved', startDate: { lte: date }, endDate: { gte: date } } })
  const types = new Map((await prisma.leaveType.findMany({ where: { companyId } })).map((t) => [t.id, t]))
  const out = new Map<string, { leaveType: string; hours: number }>()
  for (const r of reqs) {
    const d = (r.days as unknown as LeaveDay[]).find((x) => x.date === date)
    if (!d) continue
    // The board says "Off" and the kind of leave in general terms; sick leave shows as leave.
    const t = types.get(r.leaveTypeId)
    out.set(r.personId, { leaveType: t?.statutory === 'wa_sick' || t?.statutory === 'wa_pfml' ? 'Leave' : t?.name ?? 'Leave', hours: d.hours })
  }
  return out
}

/** Hours per person in a quarter, for the state Paid Family and Medical Leave report. */
export async function pfmlQuarterly(companyId: string, year: number, quarter: number) {
  if (!Number.isInteger(year) || year < 2000 || !Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    throw badRequest('year and quarter (1 to 4) are required.', { field: 'quarter' })
  }
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const tz = company.timezone
  const from = `${year}-${String((quarter - 1) * 3 + 1).padStart(2, '0')}-01`
  const toExclusive = quarter === 4 ? `${year + 1}-01-01` : `${year}-${String(quarter * 3 + 1).padStart(2, '0')}-01`
  const to = addDays(toExclusive, -1)
  const [punches, leave, sheets] = await Promise.all([
    prisma.punch.findMany({
      where: { companyId, clockOut: { not: null }, clockIn: { gte: startOfLocalDay(from, tz), lt: startOfLocalDay(toExclusive, tz) } },
      select: { personId: true, clockIn: true, clockOut: true },
    }),
    leaveForPayroll(companyId, from, to),
    prisma.timesheet.findMany({ where: { companyId, weekStart: { gte: weekOf(from, company.weekStartDay), lte: to } }, select: { personId: true, weekStart: true, status: true } }),
  ])
  const people = new Map((await prisma.person.findMany({ where: { companyId } })).map((p) => [p.id, p]))
  const rows = new Map<string, { personId: string; personName: string; personEmail: string; hoursWorked: number; paidLeaveHours: number; weeksNotApproved: number }>()
  const row = (personId: string) => {
    let r = rows.get(personId)
    const p = people.get(personId)
    if (!r) rows.set(personId, (r = { personId, personName: p?.name ?? '', personEmail: p?.email ?? '', hoursWorked: 0, paidLeaveHours: 0, weeksNotApproved: 0 }))
    return r
  }
  const weeksWorked = new Map<string, Set<string>>()
  for (const p of punches) {
    // 1099 contractor time is not reported to the state (services/workerType.ts).
    const who = people.get(p.personId)
    if (who && !accruesLeave(typeOn(who, localDate(p.clockIn, tz)))) continue
    row(p.personId).hoursWorked += (p.clockOut!.getTime() - p.clockIn.getTime()) / 3_600_000
    const w = weekOf(localDate(p.clockIn, tz), company.weekStartDay)
    weeksWorked.set(p.personId, (weeksWorked.get(p.personId) ?? new Set()).add(w))
  }
  for (const l of leave.lines) row(l.personId).paidLeaveHours += l.hours
  const approved = new Set(sheets.filter((s) => s.status === 'approved').map((s) => `${s.personId}|${s.weekStart}`))
  for (const [personId, weeks] of weeksWorked) row(personId).weeksNotApproved = [...weeks].filter((w) => !approved.has(`${personId}|${w}`)).length
  return {
    year,
    quarter,
    from,
    to,
    note: 'Hours worked are every punched hour in the quarter, approved or not; weeksNotApproved says how many of them may still change. Paid leave hours are listed apart, for payroll to decide how to report them.',
    rows: [...rows.values()]
      .map((r) => ({ ...r, hoursWorked: round2(r.hoursWorked), paidLeaveHours: round2(r.paidLeaveHours) }))
      .sort((a, b) => a.personName.localeCompare(b.personName)),
  }
}

// ─── Opening balances from the finance spreadsheet ──────────────────────────

export interface ImportInput {
  fileName: string
  contentBase64: string
  mapping?: ImportMapping
  /** Sheet row number (1 = first row) → person id, for rows matched by hand. */
  chosen?: Record<string, string>
  /** Sheet rows to leave out. */
  skip?: number[]
  switchoverDate?: string
}

const MAX_FILE_BYTES = 4 * 1024 * 1024

function readUpload(input: ImportInput): Rows {
  const b64 = String(input.contentBase64 ?? '').replace(/^data:[^,]*,/, '')
  if (!b64) throw badRequest('Attach the spreadsheet.', { field: 'contentBase64' })
  const data = Buffer.from(b64, 'base64')
  if (data.length > MAX_FILE_BYTES) throw badRequest('That file is too big for a balance sheet (4 MB at most).')
  try {
    return readSheet(String(input.fileName ?? ''), data)
  } catch (err) {
    const code = err instanceof Error ? err.message : ''
    if (code === 'old_xls') throw badRequest('That is an old .xls file. Open it in Excel and save it as .xlsx or .csv, then try again.')
    throw badRequest('That file could not be read. Save it as .xlsx or .csv and try again.')
  }
}

async function importContext(companyId: string) {
  const { types } = await ensureLeaveSetup(companyId)
  const balanceTypes = types.filter((t) => t.drawsBalance && t.active)
  const people = await prisma.person.findMany({ where: { companyId }, orderBy: { name: 'asc' } })
  return { balanceTypes, people }
}

/** Read the sheet and show what would be posted. Writes nothing. */
export async function previewImport(companyId: string, input: ImportInput) {
  const rows = readUpload(input)
  const { balanceTypes, people } = await importContext(companyId)
  const mapping = input.mapping ?? guessMapping(rows, balanceTypes)
  const width = Math.max(0, ...rows.slice(0, 50).map((r) => r.length))
  const mappingProblem = input.mapping ? checkMapping(mapping, width, new Set(balanceTypes.map((t) => t.id))) : null
  const chosen = Object.fromEntries(Object.entries(input.chosen ?? {}).map(([k, v]) => [Number(k), String(v)]))
  const skip = new Set((input.skip ?? []).map(Number))
  const built = mappingProblem ? [] : buildRows(rows, mapping, people, chosen).filter((r) => !skip.has(r.sheetRow))
  const already = await prisma.leaveLedger.findMany({ where: { companyId, sourceRef: { startsWith: 'import:' } }, select: { personId: true, leaveTypeId: true, date: true } })
  const imported = new Set(already.map((a) => `${a.personId}|${a.leaveTypeId}`))
  for (const r of built) {
    if (!r.personId) continue
    for (const b of r.balances) if (b.hours !== null && imported.has(`${r.personId}|${b.leaveTypeId}`)) r.problems.push('This person already has an opening balance for this leave type. Use an adjustment instead.')
  }
  const settings = await prisma.leaveSettings.findUnique({ where: { companyId } })
  return {
    fileName: input.fileName,
    headers: rows[mapping.headerRow] ?? [],
    sample: rows.slice(0, 8),
    rowCount: rows.length,
    mapping,
    mappingProblem,
    leaveTypes: balanceTypes.map((t) => ({ id: t.id, key: t.key, name: t.name })),
    people: people.map((p) => ({ id: p.id, name: p.name, email: p.email, active: p.active })),
    rows: built,
    ready: !mappingProblem && built.length > 0 && built.every((r) => r.personId && !r.problems.length),
    switchoverDate: input.switchoverDate || settings?.switchoverDate || null,
  }
}

/** Post the opening balances: one adjustment per person per leave type, dated the switchover day. */
export async function commitImport(actor: LeaveActor, input: ImportInput) {
  if (!input.mapping) throw badRequest('Preview the file first, then post it with the columns you checked.', { field: 'mapping' })
  const switchover = String(input.switchoverDate ?? '')
  if (!isYmd(switchover)) throw badRequest('Pick the switchover day: the date the spreadsheet balances are as of.', { field: 'switchoverDate' })
  const preview = await previewImport(actor.companyId, input)
  if (preview.mappingProblem) throw badRequest(preview.mappingProblem, { field: 'mapping' })
  const problems = preview.rows.filter((r) => !r.personId || r.problems.length)
  if (problems.length) {
    throw conflict('import_not_ready', `${problems.length} row${problems.length === 1 ? '' : 's'} still need a look. Fix them or leave them out, then post again.`, {
      rows: problems.map((r) => ({ sheetRow: r.sheetRow, problems: r.problems })),
    })
  }
  const settings = await prisma.leaveSettings.findUniqueOrThrow({ where: { companyId: actor.companyId } })
  if (settings.switchoverDate && settings.switchoverDate !== switchover) {
    throw conflict('switchover_set', `Opening balances were already posted as of ${settings.switchoverDate}. Use that date, or adjustments.`, { switchoverDate: settings.switchoverDate })
  }
  const label = String(input.fileName ?? 'spreadsheet').slice(0, 120)
  const posted = await prisma.$transaction(async (tx) => {
    let n = 0
    for (const r of preview.rows) {
      for (const b of r.balances) {
        if (b.hours === null) continue
        await lockLeave(tx, r.personId!)
        await tx.leaveLedger.create({
          data: {
            companyId: actor.companyId,
            personId: r.personId!,
            leaveTypeId: b.leaveTypeId,
            kind: 'adjustment',
            hours: b.hours,
            date: switchover,
            sourceRef: `import:${switchover}`,
            note: `Opening balance from ${label}, row ${r.sheetRow}`,
            createdById: actor.personId,
          },
        })
        n += 1
      }
    }
    await tx.leaveSettings.update({ where: { companyId: actor.companyId }, data: { switchoverDate: switchover } })
    await emit(tx, actor.companyId, 'leave.adjusted', { import: true, switchoverDate: switchover, entries: n })
    return n
  })
  return { posted, people: preview.rows.length, switchoverDate: switchover }
}

/** The first day a person can use a kind of leave (the 90-day wait), or null when there is none. */
export async function usableFromFor(companyId: string, personId: string, leaveTypeId: string, today: string): Promise<string | null> {
  const { policyFor } = await policiesOn(companyId, today)
  const policy = policyFor(personId, leaveTypeId)
  const profile = await prisma.leaveProfile.findUnique({ where: { personId } })
  const from = usableFrom(profile?.hireDate, policy?.waitingDays ?? 0)
  return from && from > today ? from : null
}

/**
 * The board with leave on it: anyone off today is marked off (with the kind of leave
 * in general terms; sick and family leave show only as "Leave"), and people off all
 * day who never punched get a row of their own.
 */
export async function boardWithLeave<R extends { personId: string; name: string; email: string; onClock: boolean }>(
  companyId: string,
  b: { date: string; rows: R[] },
  blank: (p: { id: string; name: string; email: string; division: string }) => R,
) {
  const off = await offOn(companyId, b.date)
  if (!off.size) return { ...b, rows: b.rows.map((r) => ({ ...r, off: null })) }
  const have = new Set(b.rows.map((r) => r.personId))
  const missing = await prisma.person.findMany({ where: { companyId, id: { in: [...off.keys()].filter((id) => !have.has(id)) }, active: true } })
  const rows = [...b.rows, ...missing.map((p) => blank({ id: p.id, name: p.name, email: p.email, division: p.division }))].map((r) => ({ ...r, off: off.get(r.personId) ?? null }))
  rows.sort((a, c) => Number(c.onClock) - Number(a.onClock) || Number(Boolean(a.off)) - Number(Boolean(c.off)) || a.name.localeCompare(c.name))
  return { ...b, rows }
}
