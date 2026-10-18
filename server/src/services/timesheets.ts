import type { Company, Person, Timesheet } from '@prisma/client'
import { prisma, type Tx } from '../db.js'
import { badRequest, conflict, notFound } from '../errors.js'
import { addDays, hoursBetween, isYmd, localDate, startOfLocalDay } from '../lib/time.js'
import { emit } from './events.js'
import { findExceptions, type TimeException } from './exceptions.js'

// Weekly timesheets. The tech signs their week; a manager or payroll approves it.
// Approval locks the week: punches and corrections inside it are refused until an
// approver reopens it. Any change inside a signed week sends it back for signing.
// A week belongs to the local date its segments START on, like every other report.

export type TimesheetStatus = 'open' | 'signed' | 'approved'

/** First day (YYYY-MM-DD) of the week that holds `ymd`. */
export function weekOf(ymd: string, weekStartDay: number): string {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay()
  return addDays(ymd, -((dow - weekStartDay + 7) % 7))
}

export function weekBounds(weekStart: string, tz: string) {
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i))
  return { weekStart, days, start: startOfLocalDay(weekStart, tz), end: startOfLocalDay(addDays(weekStart, 7), tz) }
}

/** The week named by any date in it (YYYY-MM-DD), or the current week. */
export function resolveWeek(company: Company, raw: string | undefined): string {
  if (raw && !isYmd(raw)) throw badRequest('week must be a date, YYYY-MM-DD.', { field: 'week' })
  return weekOf(raw || localDate(new Date(), company.timezone), company.weekStartDay)
}

const fmtWeek = (weekStart: string) =>
  new Date(`${weekStart}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })

// ─── The lock ───────────────────────────────────────────────────────────────

/**
 * Called inside every punch and correction, with the person lock held, for each
 * instant the change touches. Refuses changes inside an approved week and sends a
 * signed week back to open.
 */
export async function touchWeeks(tx: Tx, companyId: string, personId: string, instants: Date[], why: string): Promise<void> {
  const company = await tx.company.findUniqueOrThrow({ where: { id: companyId } })
  const weeks = [...new Set(instants.map((at) => weekOf(localDate(at, company.timezone), company.weekStartDay)))]
  for (const weekStart of weeks) {
    const ts = await tx.timesheet.findUnique({ where: { personId_weekStart: { personId, weekStart } } })
    if (!ts || ts.status === 'open') continue
    if (ts.status === 'approved') {
      throw conflict('week_approved', `The week of ${fmtWeek(weekStart)} is approved and locked. A manager has to reopen it first.`, { weekStart })
    }
    await tx.timesheet.update({
      where: { id: ts.id },
      data: { status: 'open', signedAt: null, signedById: null, note: `Changed after signing: ${why}` },
    })
    await emit(tx, companyId, 'timesheet.reopened', { personId, weekStart, reason: `Changed after signing: ${why}`, by: null })
  }
}

// ─── Views ──────────────────────────────────────────────────────────────────

const segInclude = {
  job: { select: { id: true, name: true, code: true, kind: true } },
  phase: { select: { id: true, key: true, name: true, short: true, laborCategory: true } },
  _count: { select: { edits: true } },
} as const

const sheetView = (ts: Timesheet | null, names: Map<string, string>) => ({
  status: (ts?.status ?? 'open') as TimesheetStatus,
  signedAt: ts?.signedAt ?? null,
  approvedAt: ts?.approvedAt ?? null,
  approvedBy: ts?.approvedById ? names.get(ts.approvedById) ?? null : null,
  hoursAtSignOff: ts && ts.status !== 'open' ? ts.hours : null,
  note: ts?.note ?? '',
})

async function nameMap(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const want = [...new Set(ids.filter((x): x is string => Boolean(x)))]
  if (!want.length) return new Map()
  const rows = await prisma.person.findMany({ where: { id: { in: want } }, select: { id: true, name: true } })
  return new Map(rows.map((r) => [r.id, r.name]))
}

/** One person's week: every segment by day, totals, sign-off state and exceptions. */
export async function personWeek(companyId: string, personId: string, rawWeek?: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const person = await prisma.person.findFirst({ where: { id: personId, companyId } })
  if (!person) throw notFound('Person')
  const weekStart = resolveWeek(company, rawWeek)
  const { days, start, end } = weekBounds(weekStart, company.timezone)
  const now = new Date()
  const [segments, ts, exceptions] = await Promise.all([
    prisma.punch.findMany({ where: { personId, clockIn: { gte: start, lt: end } }, orderBy: { clockIn: 'asc' }, include: segInclude }),
    prisma.timesheet.findUnique({ where: { personId_weekStart: { personId, weekStart } } }),
    findExceptions(companyId, { from: start, to: end, personId }),
  ])
  const names = await nameMap([ts?.approvedById])
  const byDay = new Map(days.map((d) => [d, { date: d, hours: 0, segments: [] as typeof segments }]))
  for (const s of segments) {
    const d = byDay.get(localDate(s.clockIn, company.timezone))
    if (!d) continue
    d.hours += hoursBetween(s.clockIn, s.clockOut, now)
    d.segments.push(s)
  }
  const dayRows = [...byDay.values()].map((d) => ({
    date: d.date,
    hours: d.hours,
    segments: d.segments.map(({ _count, ...s }) => ({ ...s, edited: _count.edits > 0 })),
  }))
  return {
    person: { id: person.id, name: person.name, email: person.email },
    weekStart,
    weekEnd: days[6],
    timezone: company.timezone,
    days: dayRows,
    hours: dayRows.reduce((s, d) => s + d.hours, 0),
    openSegment: segments.some((s) => !s.clockOut),
    weekOver: now.getTime() >= end.getTime(),
    ...sheetView(ts, names),
    exceptions,
  }
}

/** Everyone's week at a glance, for the approver. */
export async function weekSheet(companyId: string, rawWeek?: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const weekStart = resolveWeek(company, rawWeek)
  const { days, start, end } = weekBounds(weekStart, company.timezone)
  const now = new Date()
  const [segments, sheets, people, exceptions, pendingRows] = await Promise.all([
    prisma.punch.findMany({ where: { companyId, clockIn: { gte: start, lt: end } }, select: { personId: true, clockIn: true, clockOut: true } }),
    prisma.timesheet.findMany({ where: { companyId, weekStart } }),
    prisma.person.findMany({ where: { companyId }, select: { id: true, name: true, email: true, active: true, role: true } }),
    findExceptions(companyId, { from: start, to: end }),
    prisma.changeRequest.findMany({ where: { companyId, weekStart, status: 'pending' }, select: { personId: true } }),
  ])
  const pendingBy = new Map<string, number>()
  for (const p of pendingRows) pendingBy.set(p.personId, (pendingBy.get(p.personId) ?? 0) + 1)
  const sheetBy = new Map(sheets.map((s) => [s.personId, s]))
  const names = await nameMap(sheets.map((s) => s.approvedById))
  const rows = new Map<string, { hours: number[]; open: boolean }>()
  for (const s of segments) {
    const r = rows.get(s.personId) ?? { hours: Array(7).fill(0), open: false }
    const i = days.indexOf(localDate(s.clockIn, company.timezone))
    if (i >= 0) r.hours[i] += hoursBetween(s.clockIn, s.clockOut, now)
    if (!s.clockOut) r.open = true
    rows.set(s.personId, r)
  }
  const problemsBy = new Map<string, number>()
  for (const x of exceptions) if (x.severity === 'problem') problemsBy.set(x.personId, (problemsBy.get(x.personId) ?? 0) + 1)

  // Everyone who worked this week, plus active people with a sheet (signed with no hours is still worth seeing).
  const ids = new Set<string>([...rows.keys(), ...sheets.map((s) => s.personId), ...pendingBy.keys()])
  const out = people
    .filter((p) => ids.has(p.id))
    .map((p) => {
      const r = rows.get(p.id) ?? { hours: Array(7).fill(0), open: false }
      return {
        person: p,
        daily: r.hours,
        hours: r.hours.reduce((a, b) => a + b, 0),
        openSegment: r.open,
        problems: problemsBy.get(p.id) ?? 0,
        pendingRequests: pendingBy.get(p.id) ?? 0,
        ...sheetView(sheetBy.get(p.id) ?? null, names),
      }
    })
    .sort((a, b) => a.person.name.localeCompare(b.person.name))
  // Active people who have not punched at all this week, so a missing sheet is visible.
  const quiet = people.filter((p) => p.active && !ids.has(p.id)).map((p) => ({ id: p.id, name: p.name }))
  return {
    weekStart,
    weekEnd: days[6],
    days,
    weekOver: now.getTime() >= end.getTime(),
    rows: out,
    quiet: quiet.sort((a, b) => a.name.localeCompare(b.name)),
    exceptions,
    counts: {
      approved: out.filter((r) => r.status === 'approved').length,
      signed: out.filter((r) => r.status === 'signed').length,
      open: out.filter((r) => r.status === 'open').length,
      pendingRequests: pendingRows.length,
    },
  }
}

// ─── Sign, approve, reopen ──────────────────────────────────────────────────

async function weekTotal(tx: Tx, personId: string, company: Company, weekStart: string) {
  const { start, end } = weekBounds(weekStart, company.timezone)
  const segs = await tx.punch.findMany({ where: { personId, clockIn: { gte: start, lt: end } }, select: { clockIn: true, clockOut: true } })
  return { open: segs.some((s) => !s.clockOut), hours: segs.reduce((s, p) => s + hoursBetween(p.clockIn, p.clockOut), 0), end }
}

const lockPerson = (tx: Tx, personId: string) => tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`

/** The tech confirms their week is right. */
export async function signWeek(person: Person, rawWeek?: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: person.companyId } })
  const weekStart = resolveWeek(company, rawWeek)
  return prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id)
    const t = await weekTotal(tx, person.id, company, weekStart)
    if (t.open) throw conflict('open_segment', 'You are still on the clock in this week. Clock out first.')
    const existing = await tx.timesheet.findUnique({ where: { personId_weekStart: { personId: person.id, weekStart } } })
    if (existing?.status === 'approved') throw conflict('week_approved', 'This week is already approved.')
    const ts = await tx.timesheet.upsert({
      where: { personId_weekStart: { personId: person.id, weekStart } },
      create: { companyId: person.companyId, personId: person.id, weekStart, status: 'signed', hours: t.hours, signedAt: new Date(), signedById: person.id },
      update: { status: 'signed', hours: t.hours, signedAt: new Date(), signedById: person.id, note: '' },
    })
    await emit(tx, person.companyId, 'timesheet.signed', { personId: person.id, weekStart, hours: t.hours })
    return ts
  })
}

export interface ApproveResult {
  personId: string
  ok: boolean
  code?: string
  message?: string
  hours?: number
}

/** Approve a week for one or more people. The week must be over and nobody may still be on the clock in it. */
export async function approveWeek(companyId: string, approverId: string, personIds: string[], rawWeek?: string, note = ''): Promise<ApproveResult[]> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const weekStart = resolveWeek(company, rawWeek)
  const { end } = weekBounds(weekStart, company.timezone)
  if (Date.now() < end.getTime()) throw conflict('week_not_over', `The week of ${fmtWeek(weekStart)} is not over yet.`)
  const results: ApproveResult[] = []
  for (const personId of [...new Set(personIds)]) {
    try {
      const person = await prisma.person.findFirst({ where: { id: personId, companyId } })
      if (!person) throw notFound('Person')
      const r = await prisma.$transaction(async (tx) => {
        await lockPerson(tx, personId)
        const t = await weekTotal(tx, personId, company, weekStart)
        if (t.open) throw conflict('open_segment', `${person.name} is still on the clock in this week. Close that segment first.`)
        const pending = await tx.changeRequest.count({ where: { personId, weekStart, status: 'pending' } })
        if (pending) {
          throw conflict('pending_request', `${person.name} has ${pending === 1 ? 'a change request' : `${pending} change requests`} waiting for this week. Approve or turn ${pending === 1 ? 'it' : 'them'} down first.`)
        }
        await tx.timesheet.upsert({
          where: { personId_weekStart: { personId, weekStart } },
          create: { companyId, personId, weekStart, status: 'approved', hours: t.hours, approvedAt: new Date(), approvedById: approverId, note },
          update: { status: 'approved', hours: t.hours, approvedAt: new Date(), approvedById: approverId, note },
        })
        await emit(tx, companyId, 'timesheet.approved', { personId, weekStart, hours: t.hours, by: approverId })
        return t.hours
      })
      results.push({ personId, ok: true, hours: r })
    } catch (err) {
      const e = err as { code?: string; message?: string }
      results.push({ personId, ok: false, code: e.code ?? 'error', message: e.message ?? 'Could not approve.' })
    }
  }
  return results
}

/** Unlock an approved (or signed) week so it can be corrected. */
export async function reopenWeek(companyId: string, approverId: string, personId: string, rawWeek: string | undefined, reason: string) {
  if (!reason.trim()) throw badRequest('Say why the week is being reopened.', { field: 'reason' })
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const weekStart = resolveWeek(company, rawWeek)
  return prisma.$transaction(async (tx) => {
    await lockPerson(tx, personId)
    const ts = await tx.timesheet.findUnique({ where: { personId_weekStart: { personId, weekStart } } })
    if (!ts || ts.companyId !== companyId) throw notFound('Timesheet')
    if (ts.status === 'open') return ts
    const updated = await tx.timesheet.update({
      where: { id: ts.id },
      data: { status: 'open', signedAt: null, signedById: null, approvedAt: null, approvedById: null, note: reason.trim() },
    })
    await emit(tx, companyId, 'timesheet.reopened', { personId, weekStart, reason: reason.trim(), by: approverId })
    return updated
  })
}

export type { TimeException }
