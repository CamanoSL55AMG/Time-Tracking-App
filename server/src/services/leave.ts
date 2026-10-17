import type { LeavePolicy, LeaveType, Person, Prisma } from '@prisma/client'
import { prisma, type Tx } from '../db.js'
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js'
import { addDays, isYmd, localDate, startOfLocalDay, hoursBetween } from '../lib/time.js'
import {
  completeMonths,
  completeWeeks,
  daysBetween,
  earnedForHours,
  forfeitAtYearEnd,
  grantDates,
  lastDayOfMonth,
  parseTiers,
  rateOn,
  roundHours,
  underCap,
  usableFrom,
  type PolicyRule,
} from '../lib/leave.js'
import { emit } from './events.js'

// Leave balances are the sum of LeaveLedger rows. Nothing here overwrites a number.
// Every write that depends on a balance runs with the person's row locked, so two
// approvals at the same moment cannot both spend the same hours.

const lockPerson = (tx: Tx, personId: string) => tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`

export const todayIn = (tz: string) => localDate(new Date(), tz)

export function ymd(v: unknown, field: string): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!isYmd(s)) throw badRequest(`${field} must be a date like 2026-10-17.`, { field })
  return s
}

export function hoursOf(v: unknown, field: string, { allowNegative = false } = {}): number {
  const n = Number(v)
  if (!Number.isFinite(n) || (!allowNegative && n <= 0) || n === 0 || Math.abs(n) > 10_000) {
    throw badRequest(`${field} must be a number of hours${allowNegative ? ' (negative to take hours away)' : ''}.`, { field })
  }
  return roundHours(n)
}

const ruleOf = (p: LeavePolicy): PolicyRule => ({
  method: p.method,
  rateHours: p.rateHours,
  perHours: p.perHours,
  grantOn: p.grantOn,
  capHours: p.capHours,
  carryoverMax: p.carryoverMax,
  waitingDays: p.waitingDays,
  tiers: parseTiers(p.tiers),
})

// ─── Which policy applies to whom ───────────────────────────────────────────

export interface Coverage {
  policy: LeavePolicy
  from: string // YYYY-MM-DD
  to: string | null // inclusive
  assignmentId: string | null
}

/** Every policy that covers this person at some point, with the dates it covers. */
export async function coverageFor(db: Tx | typeof prisma, person: Person, tz: string): Promise<Coverage[]> {
  const [everyone, assigned] = await Promise.all([
    db.leavePolicy.findMany({ where: { companyId: person.companyId, appliesToAll: true, active: true } }),
    db.personLeavePolicy.findMany({ where: { personId: person.id }, include: { policy: true } }),
  ])
  // A policy that applies to everyone starts on the first day of work, or the day the
  // person was added if no start date is recorded.
  const start = person.hireDate ?? localDate(person.createdAt, tz)
  return [
    ...everyone.map((policy) => ({ policy, from: start, to: null, assignmentId: null })),
    ...assigned
      .filter((a) => a.policy.active)
      .map((a) => ({ policy: a.policy, from: a.effectiveFrom < start && person.hireDate ? start : a.effectiveFrom, to: a.effectiveTo, assignmentId: a.id })),
  ]
}

const covers = (c: Coverage, day: string) => c.from <= day && (c.to === null || day <= c.to)

/** The policy for one leave type on one day (an individual assignment wins over the company-wide one). */
export function policyOn(coverage: Coverage[], leaveTypeId: string, day: string): Coverage | null {
  const matches = coverage.filter((c) => c.policy.leaveTypeId === leaveTypeId && covers(c, day))
  return matches.find((c) => c.assignmentId) ?? matches[0] ?? null
}

// ─── Balances ───────────────────────────────────────────────────────────────

export async function balanceOf(db: Tx | typeof prisma, personId: string, leaveTypeId: string, onOrBefore?: string): Promise<number> {
  const agg = await db.leaveLedger.aggregate({
    where: { personId, leaveTypeId, date: onOrBefore ? { lte: onOrBefore } : undefined },
    _sum: { hours: true },
  })
  return roundHours(agg._sum.hours ?? 0)
}

async function pendingHours(db: Tx | typeof prisma, personId: string, leaveTypeId: string, exceptRequestId?: string): Promise<number> {
  const agg = await db.leaveRequest.aggregate({
    where: { personId, leaveTypeId, status: 'requested', id: exceptRequestId ? { not: exceptRequestId } : undefined },
    _sum: { hours: true },
  })
  return roundHours(agg._sum.hours ?? 0)
}

/** Balances for every active leave type, as the person and their manager see them. */
export async function personLeave(person: Person) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: person.companyId } })
  const tz = company.timezone
  const today = todayIn(tz)
  const yearStart = `${today.slice(0, 4)}-01-01`
  const [types, coverage, ledger, pending] = await Promise.all([
    prisma.leaveType.findMany({ where: { companyId: person.companyId, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    coverageFor(prisma, person, tz),
    prisma.leaveLedger.groupBy({ by: ['leaveTypeId', 'kind'], where: { personId: person.id }, _sum: { hours: true } }),
    prisma.leaveLedger.groupBy({ by: ['leaveTypeId', 'kind'], where: { personId: person.id, date: { gte: yearStart } }, _sum: { hours: true } }),
  ])
  const requested = await prisma.leaveRequest.groupBy({ by: ['leaveTypeId'], where: { personId: person.id, status: 'requested' }, _sum: { hours: true } })

  const sum = (rows: typeof ledger, typeId: string, kinds?: string[]) =>
    roundHours(rows.filter((r) => r.leaveTypeId === typeId && (!kinds || kinds.includes(r.kind))).reduce((t, r) => t + (r._sum.hours ?? 0), 0))

  return {
    asOf: today,
    hireDate: person.hireDate,
    sickNoticeAcknowledgedAt: person.sickNoticeAckAt,
    types: types.map((t) => {
      const current = policyOn(coverage, t.id, today)
      const balance = sum(ledger, t.id)
      const pend = roundHours(requested.find((r) => r.leaveTypeId === t.id)?._sum.hours ?? 0)
      const usable = current ? usableFrom(person.hireDate, current.policy.waitingDays) : null
      return {
        leaveType: typeView(t),
        policy: current ? policyView(current.policy) : null,
        balance,
        pending: pend,
        available: t.drawsBalance ? roundHours(balance - pend) : null,
        earnedThisYear: sum(pending, t.id, ['accrual']),
        usedThisYear: roundHours(-sum(pending, t.id, ['use'])),
        usableFrom: usable,
        usableNow: !current || !current.policy.waitingDays ? true : usable ? usable <= today : null,
      }
    }),
  }
}

export const typeView = (t: LeaveType) => ({
  id: t.id,
  key: t.key,
  name: t.name,
  paid: t.paid,
  drawsBalance: t.drawsBalance,
  statutory: t.statutory,
  sortOrder: t.sortOrder,
  active: t.active,
})

export const policyView = (p: LeavePolicy) => ({
  id: p.id,
  leaveTypeId: p.leaveTypeId,
  name: p.name,
  method: p.method,
  rateHours: p.rateHours,
  perHours: p.perHours,
  grantOn: p.grantOn,
  capHours: p.capHours,
  carryoverMax: p.carryoverMax,
  waitingDays: p.waitingDays,
  tiers: parseTiers(p.tiers),
  appliesToAll: p.appliesToAll,
  active: p.active,
})

// ─── Accrual ────────────────────────────────────────────────────────────────

/**
 * Accrue every active person's leave through `through` (a YYYY-MM-DD in the company
 * timezone). Safe to run again: each week, month or grant is written once
 * (sourceRef is unique), so a second run only fills what is missing.
 *
 * Hours worked are closed punch segments starting in the week, in the company
 * timezone. Weeks run Monday to Sunday and count only once they are over.
 */
export async function accrueThrough(companyId: string, through: string, byPersonId: string | null = null) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const tz = company.timezone
  const people = await prisma.person.findMany({ where: { companyId, active: true } })
  let entries = 0
  let hours = 0
  const touched = new Set<string>()

  for (const person of people) {
    const coverage = await coverageFor(prisma, person, tz)
    for (const c of coverage) {
      const rule = ruleOf(c.policy)
      const end = c.to && c.to < through ? c.to : through
      if (c.from > end) continue

      const done = new Set(
        (
          await prisma.leaveLedger.findMany({
            where: { personId: person.id, leaveTypeId: c.policy.leaveTypeId, sourceRef: { startsWith: `accrual:${c.policy.id}:` } },
            select: { sourceRef: true },
          })
        ).map((r) => r.sourceRef),
      )
      for (const r of await prisma.leaveLedger.findMany({
        where: { personId: person.id, leaveTypeId: c.policy.leaveTypeId, sourceRef: { startsWith: `grant:${c.policy.id}:` } },
        select: { sourceRef: true },
      }))
        done.add(r.sourceRef)

      const candidates: { ref: string; date: string; earned: () => Promise<number>; note: string }[] = []

      if (rule.method === 'per_hours_worked') {
        // Nothing to earn before the first punch, so start there.
        const first = await prisma.punch.findFirst({ where: { personId: person.id, clockOut: { not: null } }, orderBy: { clockIn: 'asc' }, select: { clockIn: true } })
        if (!first) continue
        const firstDay = localDate(first.clockIn, tz)
        const from = c.from > firstDay ? c.from : firstDay
        for (const week of completeWeeks(from, end)) {
          const ref = `accrual:${c.policy.id}:${week}`
          if (done.has(ref)) continue
          const sunday = addDays(week, 6)
          candidates.push({
            ref,
            date: sunday,
            note: `Week of ${week}`,
            earned: async () => {
              // Only the part of the week inside the policy's dates counts.
              const lo = week < c.from ? c.from : week
              const hi = c.to && c.to < sunday ? c.to : sunday
              const worked = await workedHours(person.id, startOfLocalDay(lo, tz), startOfLocalDay(addDays(hi, 1), tz))
              return earnedForHours(worked, rateOn(rule, person.hireDate, sunday), rule.perHours)
            },
          })
        }
      } else if (rule.method === 'per_month') {
        for (const month of completeMonths(c.from, end)) {
          const ref = `accrual:${c.policy.id}:${month}`
          if (done.has(ref)) continue
          const last = lastDayOfMonth(month)
          candidates.push({ ref, date: last, note: `Month of ${month}`, earned: async () => roundHours(rateOn(rule, person.hireDate, last)) })
        }
      } else if (rule.method === 'annual_grant') {
        for (const day of grantDates(rule.grantOn, person.hireDate, c.from, end)) {
          const ref = `grant:${c.policy.id}:${day}`
          if (done.has(ref)) continue
          candidates.push({ ref, date: day, note: `Annual grant ${day.slice(0, 4)}`, earned: async () => roundHours(rateOn(rule, person.hireDate, day)) })
        }
      }

      for (const cand of candidates) {
        const earned = await cand.earned()
        if (earned <= 0) continue // nothing worked that week: nothing to record
        const wrote = await prisma.$transaction(async (tx) => {
          await lockPerson(tx, person.id)
          const balance = await balanceOf(tx, person.id, c.policy.leaveTypeId)
          const add = underCap(balance, earned, rule.capHours)
          const res = await tx.leaveLedger.createMany({
            data: [
              {
                companyId,
                personId: person.id,
                leaveTypeId: c.policy.leaveTypeId,
                kind: 'accrual',
                hours: add,
                date: cand.date,
                sourceRef: cand.ref,
                note: add < earned ? `${cand.note}. ${roundHours(earned - add)} h not added: balance at the ${rule.capHours} h cap` : cand.note,
                createdById: byPersonId,
              },
            ],
            skipDuplicates: true,
          })
          return res.count ? add : null
        })
        if (wrote !== null) {
          entries += 1
          hours += wrote
          touched.add(person.id)
        }
      }
    }
  }

  if (entries) {
    await prisma.$transaction((tx) => emit(tx, companyId, 'leave.accrued', { through, entries, hours: roundHours(hours), people: [...touched] }))
  }
  return { through, entries, hours: roundHours(hours), people: touched.size }
}

async function workedHours(personId: string, from: Date, to: Date): Promise<number> {
  const rows = await prisma.punch.findMany({
    where: { personId, clockIn: { gte: from, lt: to }, clockOut: { not: null } },
    select: { clockIn: true, clockOut: true },
  })
  return rows.reduce((t, p) => t + hoursBetween(p.clockIn, p.clockOut), 0)
}

/**
 * Year end: hours above a policy's carryover limit are forfeited on 1 January.
 * Washington sick leave carries over up to 40 hours. Safe to run again.
 */
export async function yearEnd(companyId: string, year: number, byPersonId: string | null = null) {
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw badRequest('year must be a year like 2026.', { field: 'year' })
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const lastDay = `${year}-12-31`
  const newYear = `${year + 1}-01-01`
  const people = await prisma.person.findMany({ where: { companyId } })
  let forfeited = 0
  let entries = 0
  for (const person of people) {
    const coverage = await coverageFor(prisma, person, company.timezone)
    const typeIds = [...new Set(coverage.map((c) => c.policy.leaveTypeId))]
    for (const typeId of typeIds) {
      const c = policyOn(coverage, typeId, lastDay)
      if (!c || c.policy.carryoverMax === null) continue
      const excess = await prisma.$transaction(async (tx) => {
        await lockPerson(tx, person.id)
        const balance = await balanceOf(tx, person.id, typeId, lastDay)
        const lose = forfeitAtYearEnd(balance, c.policy.carryoverMax)
        if (lose <= 0) return 0
        const res = await tx.leaveLedger.createMany({
          data: [
            {
              companyId,
              personId: person.id,
              leaveTypeId: typeId,
              kind: 'forfeit',
              hours: -lose,
              date: newYear,
              sourceRef: `yearend:${year}`,
              note: `Above the ${c.policy.carryoverMax} h carryover limit at the end of ${year}`,
              createdById: byPersonId,
            },
          ],
          skipDuplicates: true,
        })
        return res.count ? lose : 0
      })
      if (excess) {
        forfeited += excess
        entries += 1
      }
    }
  }
  if (entries) await prisma.$transaction((tx) => emit(tx, companyId, 'leave.adjusted', { yearEnd: year, entries, hours: roundHours(-forfeited) }))
  return { year, entries, hoursForfeited: roundHours(forfeited) }
}

// ─── Requests ───────────────────────────────────────────────────────────────

const requestInclude = { leaveType: true, person: { select: { id: true, name: true, email: true } } } satisfies Prisma.LeaveRequestInclude

export async function createRequest(
  person: Person,
  input: { leaveTypeId: string; startDate: string; endDate: string; hours: number; note: string },
) {
  if (input.endDate < input.startDate) throw badRequest('endDate is before startDate.', { field: 'endDate' })
  const days = daysBetween(input.startDate, input.endDate) + 1
  if (days > 366) throw badRequest('A request can cover a year at most.', { field: 'endDate' })
  if (input.hours > days * 24) throw badRequest(`${input.hours} hours do not fit in ${days} day(s).`, { field: 'hours' })

  const company = await prisma.company.findUniqueOrThrow({ where: { id: person.companyId } })
  const type = await prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, companyId: person.companyId, active: true } })
  if (!type) throw notFound('Leave type')

  const coverage = await coverageFor(prisma, person, company.timezone)
  const c = policyOn(coverage, type.id, input.startDate)
  if (c?.policy.waitingDays) {
    const from = usableFrom(person.hireDate, c.policy.waitingDays)
    if (from && input.startDate < from) {
      throw conflict('not_yet_usable', `${type.name} can be used from ${from}, ${c.policy.waitingDays} days after the start date.`, { usableFrom: from })
    }
  }

  return prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id)
    const overlap = await tx.leaveRequest.findFirst({
      where: { personId: person.id, status: { in: ['requested', 'approved'] }, startDate: { lte: input.endDate }, endDate: { gte: input.startDate } },
    })
    if (overlap) throw conflict('leave_overlap', `This overlaps a ${overlap.status} request for ${overlap.startDate} to ${overlap.endDate}.`, { requestId: overlap.id })
    if (type.drawsBalance) await assertAvailable(tx, person.id, type, input.hours)
    const req = await tx.leaveRequest.create({
      data: { companyId: person.companyId, personId: person.id, leaveTypeId: type.id, startDate: input.startDate, endDate: input.endDate, hours: input.hours, note: input.note },
      include: requestInclude,
    })
    await emit(tx, person.companyId, 'leave.requested', { request: summary(req) })
    return req
  })
}

async function assertAvailable(tx: Tx, personId: string, type: LeaveType, hours: number, exceptRequestId?: string) {
  const available = roundHours((await balanceOf(tx, personId, type.id)) - (await pendingHours(tx, personId, type.id, exceptRequestId)))
  if (hours > available + 1e-9) {
    throw conflict('insufficient_balance', `Only ${available} h of ${type.name} is available.`, { available, requested: hours })
  }
}

const summary = (r: { id: string; personId: string; leaveTypeId: string; startDate: string; endDate: string; hours: number; status: string }) => ({
  id: r.id,
  personId: r.personId,
  leaveTypeId: r.leaveTypeId,
  startDate: r.startDate,
  endDate: r.endDate,
  hours: r.hours,
  status: r.status,
})

export interface Decider {
  companyId: string
  personId: string | null // null when an integration key decides
  isAdmin: boolean
}

async function lockedRequest(tx: Tx, companyId: string, id: string) {
  await tx.$queryRaw`SELECT id FROM "LeaveRequest" WHERE id = ${id} FOR UPDATE`
  const req = await tx.leaveRequest.findFirst({ where: { id, companyId }, include: { leaveType: true } })
  if (!req) throw notFound('Leave request')
  return req
}

export async function decideRequest(by: Decider, id: string, decision: 'approve' | 'deny', note: string) {
  return prisma.$transaction(async (tx) => {
    const req = await lockedRequest(tx, by.companyId, id)
    if (req.status !== 'requested') throw conflict('not_pending', `This request is already ${req.status}.`)
    if (req.personId === by.personId && !by.isAdmin) throw forbidden('Someone else has to decide your own request.')
    await lockPerson(tx, req.personId)
    if (decision === 'approve') {
      if (req.leaveType.drawsBalance) await assertAvailable(tx, req.personId, req.leaveType, req.hours, req.id)
      await tx.leaveLedger.create({
        data: {
          companyId: by.companyId,
          personId: req.personId,
          leaveTypeId: req.leaveTypeId,
          kind: 'use',
          hours: req.leaveType.drawsBalance ? -req.hours : 0,
          date: req.startDate,
          sourceRef: `request:${req.id}`,
          note: req.startDate === req.endDate ? `Time off ${req.startDate}` : `Time off ${req.startDate} to ${req.endDate}`,
          createdById: by.personId,
        },
      })
    } else if (!note) {
      throw badRequest('Say why the request is denied.', { field: 'note' })
    }
    const saved = await tx.leaveRequest.update({
      where: { id: req.id },
      data: { status: decision === 'approve' ? 'approved' : 'denied', decidedById: by.personId, decidedAt: new Date(), decisionNote: note },
      include: requestInclude,
    })
    await emit(tx, by.companyId, decision === 'approve' ? 'leave.approved' : 'leave.denied', { request: summary(saved) })
    return saved
  })
}

/** Withdraw a request. If it was approved, its hours go back on the balance. */
export async function cancelRequest(by: Decider & { canApprove: boolean }, id: string, note: string) {
  return prisma.$transaction(async (tx) => {
    const req = await lockedRequest(tx, by.companyId, id)
    const own = req.personId === by.personId
    if (!own && !by.canApprove) throw forbidden('That is not your request.')
    if (req.status !== 'requested' && req.status !== 'approved') throw conflict('not_cancellable', `This request is already ${req.status}.`)
    if (req.status === 'approved') {
      const company = await tx.company.findUniqueOrThrow({ where: { id: by.companyId } })
      // A person can take back approved time off only before it starts.
      if (own && !by.canApprove && req.startDate <= todayIn(company.timezone)) {
        throw conflict('already_started', 'This time off has started. Ask your manager to change it.')
      }
      await lockPerson(tx, req.personId)
      const used = await tx.leaveLedger.findUnique({
        where: { companyId_personId_leaveTypeId_sourceRef: { companyId: by.companyId, personId: req.personId, leaveTypeId: req.leaveTypeId, sourceRef: `request:${req.id}` } },
      })
      if (used && used.hours !== 0) {
        await tx.leaveLedger.create({
          data: {
            companyId: by.companyId,
            personId: req.personId,
            leaveTypeId: req.leaveTypeId,
            kind: 'adjustment',
            hours: -used.hours,
            date: req.startDate,
            sourceRef: `request-cancel:${req.id}`,
            note: `Cancelled time off ${req.startDate}${note ? `: ${note}` : ''}`,
            createdById: by.personId,
          },
        })
      }
    }
    const saved = await tx.leaveRequest.update({
      where: { id: req.id },
      data: { status: 'cancelled', decidedById: by.personId, decidedAt: new Date(), decisionNote: note },
      include: requestInclude,
    })
    await emit(tx, by.companyId, 'leave.cancelled', { request: summary(saved) })
    return saved
  })
}

export const leaveRequestInclude = requestInclude

// ─── Adjustments and opening balances ───────────────────────────────────────

export const ADJUST_KINDS = ['adjustment', 'payout', 'reinstate', 'carryover'] as const

export async function adjust(
  companyId: string,
  byPersonId: string | null,
  input: { personId: string; leaveTypeId: string; hours: number; date: string; reason: string; kind: string; sourceRef?: string },
) {
  if (!(ADJUST_KINDS as readonly string[]).includes(input.kind)) throw badRequest(`kind must be one of ${ADJUST_KINDS.join(', ')}.`, { field: 'kind' })
  if (!input.reason) throw badRequest('A reason is required for every adjustment.', { field: 'reason' })
  const [person, type] = await Promise.all([
    prisma.person.findFirst({ where: { id: input.personId, companyId } }),
    prisma.leaveType.findFirst({ where: { id: input.leaveTypeId, companyId } }),
  ])
  if (!person) throw notFound('Person')
  if (!type) throw notFound('Leave type')
  return prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id)
    const row = await tx.leaveLedger.create({
      data: {
        companyId,
        personId: person.id,
        leaveTypeId: type.id,
        kind: input.kind,
        hours: input.kind === 'payout' ? -Math.abs(input.hours) : input.hours,
        date: input.date,
        sourceRef: input.sourceRef ?? `${input.kind}:${crypto.randomUUID()}`,
        note: input.reason,
        createdById: byPersonId,
      },
    })
    await emit(tx, companyId, 'leave.adjusted', { entry: { id: row.id, personId: row.personId, leaveTypeId: row.leaveTypeId, kind: row.kind, hours: row.hours, date: row.date } })
    return { entry: row, balance: await balanceOf(tx, person.id, type.id) }
  })
}

export interface OpeningRow {
  email: string
  leaveType: string // key or name
  hours: number
}

/**
 * Starting balances from finance's spreadsheet. With dryRun nothing is written and
 * each row says what would happen. One opening entry per person per type per date,
 * so importing the same file twice is refused row by row instead of doubling.
 */
export async function importOpening(companyId: string, byPersonId: string | null, date: string, rows: OpeningRow[], dryRun: boolean) {
  if (!rows.length) throw badRequest('There are no rows to import.')
  if (rows.length > 2000) throw badRequest('Import 2000 rows at most at a time.')
  const [people, types] = await Promise.all([
    prisma.person.findMany({ where: { companyId } }),
    prisma.leaveType.findMany({ where: { companyId } }),
  ])
  const ref = `opening:${date}`
  const results = []
  for (const [i, r] of rows.entries()) {
    const email = String(r.email ?? '').trim().toLowerCase()
    const label = String(r.leaveType ?? '').trim().toLowerCase()
    const hours = Number(r.hours)
    const person = people.find((p) => p.email === email)
    const type = types.find((t) => t.key.toLowerCase() === label || t.name.toLowerCase() === label)
    const problem = !person
      ? `No person with email ${email || '(blank)'}`
      : !type
        ? `No leave type called "${r.leaveType}"`
        : !Number.isFinite(hours)
          ? 'Hours is not a number'
          : !type.drawsBalance
            ? `${type.name} has no balance to set`
            : null
    let status: 'ready' | 'imported' | 'already_imported' | 'error' = problem ? 'error' : 'ready'
    if (!problem && person && type) {
      const exists = await prisma.leaveLedger.findUnique({
        where: { companyId_personId_leaveTypeId_sourceRef: { companyId, personId: person.id, leaveTypeId: type.id, sourceRef: ref } },
      })
      if (exists) status = 'already_imported'
      else if (!dryRun) {
        await adjust(companyId, byPersonId, { personId: person.id, leaveTypeId: type.id, hours: roundHours(hours), date, reason: `Opening balance from the finance spreadsheet, ${date}`, kind: 'adjustment', sourceRef: ref })
        status = 'imported'
      }
    }
    results.push({ row: i + 1, email, leaveType: type?.name ?? r.leaveType, hours, personName: person?.name ?? null, status, problem })
  }
  return {
    date,
    dryRun,
    ready: results.filter((r) => r.status === 'ready').length,
    imported: results.filter((r) => r.status === 'imported').length,
    alreadyImported: results.filter((r) => r.status === 'already_imported').length,
    errors: results.filter((r) => r.status === 'error').length,
    rows: results,
  }
}

// ─── Statements ─────────────────────────────────────────────────────────────

/**
 * Monthly statement per person and leave type: opening, earned, used, other
 * changes, closing. Washington requires sick-leave statements at least monthly.
 */
export async function statements(companyId: string, month: string, personId?: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('month must look like 2026-10.', { field: 'month' })
  const first = `${month}-01`
  const last = lastDayOfMonth(month)
  const [people, types, rows] = await Promise.all([
    prisma.person.findMany({ where: { companyId, id: personId }, orderBy: { name: 'asc' } }),
    prisma.leaveType.findMany({ where: { companyId, drawsBalance: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
    prisma.leaveLedger.findMany({ where: { companyId, personId, date: { lte: last } }, select: { personId: true, leaveTypeId: true, kind: true, hours: true, date: true } }),
  ])
  const out = []
  for (const p of people) {
    const lines = []
    for (const t of types) {
      const mine = rows.filter((r) => r.personId === p.id && r.leaveTypeId === t.id)
      if (!mine.length) continue
      const before = mine.filter((r) => r.date < first)
      const during = mine.filter((r) => r.date >= first)
      const s = (xs: typeof mine) => roundHours(xs.reduce((a, r) => a + r.hours, 0))
      lines.push({
        leaveType: typeView(t),
        opening: s(before),
        earned: s(during.filter((r) => r.kind === 'accrual')),
        used: roundHours(-s(during.filter((r) => r.kind === 'use'))),
        otherChanges: s(during.filter((r) => r.kind !== 'accrual' && r.kind !== 'use')),
        closing: s(mine),
      })
    }
    if (lines.length) out.push({ person: { id: p.id, name: p.name, email: p.email }, lines })
  }
  return { month, from: first, to: last, statements: out }
}

export function assertMonth(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : ''
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(s)) throw new ApiError(400, 'bad_request', 'month must look like 2026-10.', { field: 'month' })
  return s
}
