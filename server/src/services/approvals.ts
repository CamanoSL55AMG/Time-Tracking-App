import type { Company, Person } from '@prisma/client'
import { prisma, type Tx } from '../db.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { hoursBetween, isYmd, localDate, weekBounds, weekOf } from '../lib/time.js'
import { emit } from './events.js'
import { findExceptions } from './exceptions.js'

// Weekly sign-off. The tech signs their week; any manager approves it. Approved
// weeks are frozen so payroll reads numbers that cannot move underneath it.

export function checkWeek(company: Company, week: string): string {
  if (!isYmd(week)) throw badRequest('week must be a date, YYYY-MM-DD.', { field: 'week' })
  const start = weekOf(week, company.weekStartDay)
  if (start !== week) {
    throw badRequest(`Weeks start on ${DAY_NAMES[company.weekStartDay]}. The week holding ${week} starts ${start}.`, { field: 'week', weekStart: start })
  }
  return week
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** The week holding the instant `at`. */
export const weekAt = (company: Company, at: Date) => weekOf(localDate(at, company.timezone), company.weekStartDay)

/**
 * Called inside every transaction that adds or changes a person's punches, with the
 * instants being touched. Refuses a change to an approved week; a change to a week
 * that was only signed clears the signature so the tech looks at it again.
 */
export async function guardWeeks(tx: Tx, companyId: string, personId: string, instants: Date[]): Promise<void> {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } })
  const weeks = [...new Set(instants.map((at) => weekAt(company, at)))]
  const rows = await tx.approval.findMany({ where: { personId, week: { in: weeks } } })
  const approved = rows.find((r) => r.approvedAt)
  if (approved) {
    throw conflict('week_approved', `The week of ${approved.week} is approved. A manager must reopen it before its time can change.`, { week: approved.week })
  }
  const signed = rows.filter((r) => r.signedAt)
  if (signed.length) {
    await tx.approval.updateMany({ where: { id: { in: signed.map((r) => r.id) } }, data: { signedAt: null } })
  }
}

/** Hours and open-segment flag for some people in a week. */
async function weekHours(companyId: string, start: Date, end: Date, personIds?: string[]) {
  const punches = await prisma.punch.findMany({
    where: { companyId, clockIn: { gte: start, lt: end }, personId: personIds ? { in: personIds } : undefined },
    select: { personId: true, clockIn: true, clockOut: true },
  })
  const now = new Date()
  const by = new Map<string, { hours: number; open: boolean; segments: number }>()
  for (const p of punches) {
    const r = by.get(p.personId) ?? { hours: 0, open: false, segments: 0 }
    r.hours += hoursBetween(p.clockIn, p.clockOut, now)
    r.open ||= !p.clockOut
    r.segments += 1
    by.set(p.personId, r)
  }
  return by
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** Everyone's standing for one week: hours, signed, approved, things to look at. */
export async function weekSummary(companyId: string, week: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  checkWeek(company, week)
  const { start, end, days } = weekBounds(week, company.timezone)
  const [hours, approvals, people, exceptions] = await Promise.all([
    weekHours(companyId, start, end),
    prisma.approval.findMany({ where: { companyId, week } }),
    prisma.person.findMany({ where: { companyId }, orderBy: { name: 'asc' } }),
    findExceptions(company, { from: days[0], to: days[6] }),
  ])
  const approvers = new Map(people.map((p) => [p.id, p.name]))
  const byPerson = new Map(approvals.map((a) => [a.personId, a]))
  const ended = end.getTime() <= Date.now()

  const rows = people
    // Active people, and anyone inactive who still has time or a sign-off this week.
    .filter((p) => p.active || hours.has(p.id) || byPerson.has(p.id))
    .map((p) => {
      const h = hours.get(p.id)
      const a = byPerson.get(p.id)
      const mine = exceptions.filter((e) => e.personId === p.id)
      return {
        personId: p.id,
        name: p.name,
        email: p.email,
        role: p.role,
        active: p.active,
        hours: round2(h?.hours ?? 0),
        segments: h?.segments ?? 0,
        onClock: h?.open ?? false,
        signedAt: a?.signedAt ?? null,
        approvedAt: a?.approvedAt ?? null,
        approvedBy: a?.approvedById ? approvers.get(a.approvedById) ?? '' : '',
        approvedHours: a?.approvedAt ? a.hours : null,
        warnings: mine.filter((e) => e.severity === 'warn').length,
        notes: mine.filter((e) => e.severity === 'info').length,
      }
    })

  return {
    week,
    days,
    weekStartDay: company.weekStartDay,
    ended,
    totals: {
      people: rows.length,
      hours: round2(rows.reduce((s, r) => s + r.hours, 0)),
      signed: rows.filter((r) => r.signedAt).length,
      approved: rows.filter((r) => r.approvedAt).length,
    },
    rows,
  }
}

/** One person's week, day by day, with the things to look at. */
export async function personWeek(companyId: string, personId: string, week: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  checkWeek(company, week)
  const person = await prisma.person.findFirst({ where: { id: personId, companyId } })
  if (!person) throw notFound('Person')
  const { start, end, days } = weekBounds(week, company.timezone)
  const [punches, approval, exceptions] = await Promise.all([
    prisma.punch.findMany({
      where: { personId, clockIn: { gte: start, lt: end } },
      include: { job: true, phase: true, edits: { orderBy: { at: 'asc' } } },
      orderBy: { clockIn: 'asc' },
    }),
    prisma.approval.findUnique({ where: { personId_week: { personId, week } } }),
    findExceptions(company, { from: days[0], to: days[6], personId }),
  ])
  const approver = approval?.approvedById ? await prisma.person.findUnique({ where: { id: approval.approvedById }, select: { name: true } }) : null
  const now = new Date()
  const byDay = days.map((date) => {
    const segs = punches.filter((p) => localDate(p.clockIn, company.timezone) === date)
    return {
      date,
      hours: round2(segs.reduce((s, p) => s + hoursBetween(p.clockIn, p.clockOut, now), 0)),
      punches: segs,
      exceptions: exceptions.filter((e) => e.date === date),
    }
  })
  return {
    week,
    person: { id: person.id, name: person.name, email: person.email },
    ended: end.getTime() <= now.getTime(),
    hours: round2(byDay.reduce((s, d) => s + d.hours, 0)),
    onClock: punches.some((p) => !p.clockOut),
    signedAt: approval?.signedAt ?? null,
    approvedAt: approval?.approvedAt ?? null,
    approvedBy: approver?.name ?? '',
    days: byDay,
  }
}

/** The tech's own signature on their week. */
export async function signWeek(person: Person, week: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: person.companyId } })
  checkWeek(company, week)
  const { start, end } = weekBounds(week, company.timezone)
  if (start.getTime() > Date.now()) throw badRequest('That week has not started yet.', { field: 'week' })
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${person.id} FOR UPDATE`
    const open = await tx.punch.findFirst({ where: { personId: person.id, clockOut: null, clockIn: { lt: end } } })
    if (open) throw conflict('on_clock', 'Clock out before signing the week.')
    const existing = await tx.approval.findUnique({ where: { personId_week: { personId: person.id, week } } })
    if (existing?.approvedAt) throw conflict('week_approved', 'This week is already approved.')
    const row = await tx.approval.upsert({
      where: { personId_week: { personId: person.id, week } },
      create: { companyId: person.companyId, personId: person.id, week, signedAt: new Date() },
      update: { signedAt: new Date() },
    })
    await emit(tx, person.companyId, 'approval.signed', { personId: person.id, week })
    return row
  })
}

export interface ApproveResult {
  personId: string
  ok: boolean
  code?: string
  message?: string
  hours?: number
}

/** Approve one or more people's week. Each person succeeds or fails on its own. */
export async function approveWeek(companyId: string, approverId: string | null, personIds: string[], week: string, note = '') {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  checkWeek(company, week)
  const { start, end } = weekBounds(week, company.timezone)
  if (end.getTime() > Date.now()) throw conflict('week_not_over', 'A week can be approved once it is over.', { endsAt: end })
  if (!personIds.length) throw badRequest('Name at least one person.', { field: 'personIds' })

  const results: ApproveResult[] = []
  for (const personId of [...new Set(personIds)]) {
    try {
      const hours = await prisma.$transaction(async (tx) => {
        const person = await tx.person.findFirst({ where: { id: personId, companyId } })
        if (!person) throw notFound('Person')
        await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
        const open = await tx.punch.findFirst({ where: { personId, clockOut: null, clockIn: { lt: end } } })
        if (open) throw conflict('on_clock', `${person.name} is still on the clock from that week. Correct the open segment first.`)
        const segs = await tx.punch.findMany({ where: { personId, clockIn: { gte: start, lt: end } }, select: { clockIn: true, clockOut: true } })
        const total = round2(segs.reduce((s, p) => s + hoursBetween(p.clockIn, p.clockOut), 0))
        const existing = await tx.approval.findUnique({ where: { personId_week: { personId, week } } })
        if (existing?.approvedAt) return existing.hours
        await tx.approval.upsert({
          where: { personId_week: { personId, week } },
          create: { companyId, personId, week, approvedAt: new Date(), approvedById: approverId, hours: total, note },
          update: { approvedAt: new Date(), approvedById: approverId, hours: total, note },
        })
        await emit(tx, companyId, 'approval.approved', { personId, week, hours: total, signed: Boolean(existing?.signedAt) })
        return total
      })
      results.push({ personId, ok: true, hours })
    } catch (err) {
      const e = err as { code?: string; message?: string }
      results.push({ personId, ok: false, code: e.code ?? 'error', message: e.message ?? 'Could not approve.' })
    }
  }
  return { week, results }
}

/** Undo an approval so the week's time can be corrected. A reason is required. */
export async function reopenWeek(companyId: string, byId: string | null, personId: string, week: string, reason: string) {
  if (!reason.trim()) throw badRequest('A reason is required to reopen a week.', { field: 'reason' })
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  checkWeek(company, week)
  return prisma.$transaction(async (tx) => {
    const row = await tx.approval.findFirst({ where: { companyId, personId, week } })
    if (!row?.approvedAt) throw conflict('not_approved', 'That week is not approved.')
    const updated = await tx.approval.update({
      where: { id: row.id },
      data: { approvedAt: null, approvedById: null, signedAt: null, note: `Reopened: ${reason.trim()}` },
    })
    await emit(tx, companyId, 'approval.reopened', { personId, week, reason: reason.trim(), by: byId })
    return updated
  })
}
