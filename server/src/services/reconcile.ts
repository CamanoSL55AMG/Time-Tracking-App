import type { Company } from '@prisma/client'
import { prisma } from '../db.js'
import { badRequest } from '../errors.js'
import { addDays, hoursBetween, isYmd, localDate, startOfLocalDay } from '../lib/time.js'

// Parallel run: another system's hours (Timesheets.com) beside ours, per person per
// day. Cutover waits until the differences are zero, or explained, for two pay periods.

/** Differences smaller than this (6 minutes) are rounding, not a mismatch. */
export const TOLERANCE_H = 0.1
const MAX_DAYS = 92
const MAX_ROWS = 20_000

function range(from: string, to: string) {
  if (!isYmd(from) || !isYmd(to)) throw badRequest('from and to are dates, YYYY-MM-DD.')
  if (to < from) throw badRequest('to must be on or after from.')
  if (addDays(from, MAX_DAYS) < to) throw badRequest(`${MAX_DAYS} days at most per request.`)
}

export async function replaceExternalHours(companyId: string, system: string, from: string, to: string, rowsIn: unknown) {
  if (!/^[a-z0-9-]{2,40}$/.test(system)) throw badRequest('system is a short lowercase name, e.g. timesheets.', { field: 'system' })
  range(from, to)
  if (!Array.isArray(rowsIn)) throw badRequest('rows must be an array of { email, date, hours }.', { field: 'rows' })
  if (rowsIn.length > MAX_ROWS) throw badRequest(`${MAX_ROWS} rows at most.`, { field: 'rows' })

  const people = await prisma.person.findMany({ where: { companyId }, select: { id: true, email: true } })
  const byEmail = new Map(people.map((p) => [p.email.toLowerCase(), p.id]))
  const unknown = new Set<string>()
  const merged = new Map<string, { personId: string; date: string; hours: number }>()

  rowsIn.forEach((raw, i) => {
    const r = (raw ?? {}) as Record<string, unknown>
    const email = String(r.email ?? '').trim().toLowerCase()
    const date = String(r.date ?? '')
    const hours = Number(r.hours)
    if (!isYmd(date) || date < from || date > to) throw badRequest(`rows[${i}].date must be inside ${from} … ${to}.`, { row: i })
    if (!Number.isFinite(hours) || hours < 0 || hours > 24) throw badRequest(`rows[${i}].hours must be 0 to 24.`, { row: i })
    const personId = byEmail.get(email)
    if (!personId) {
      if (email) unknown.add(email)
      return
    }
    // Two rows for the same person and day (two entries in Timesheets) add up.
    const key = `${personId}|${date}`
    const m = merged.get(key) ?? { personId, date, hours: 0 }
    m.hours += hours
    merged.set(key, m)
  })

  await prisma.$transaction([
    prisma.externalHours.deleteMany({ where: { companyId, system, date: { gte: from, lte: to } } }),
    prisma.externalHours.createMany({
      data: [...merged.values()].map((m) => ({ companyId, system, personId: m.personId, date: m.date, hours: Math.round(m.hours * 100) / 100 })),
    }),
  ])
  return { system, from, to, stored: merged.size, unknownEmails: [...unknown].sort() }
}

export async function reconcile(company: Company, system: string, from: string, to: string) {
  range(from, to)
  const tz = company.timezone
  const [punches, theirs, people, lastSync] = await Promise.all([
    prisma.punch.findMany({
      where: { companyId: company.id, clockIn: { gte: startOfLocalDay(from, tz), lt: startOfLocalDay(addDays(to, 1), tz) } },
      select: { personId: true, clockIn: true, clockOut: true },
      take: MAX_ROWS + 1,
    }),
    prisma.externalHours.findMany({ where: { companyId: company.id, system, date: { gte: from, lte: to } } }),
    prisma.person.findMany({ where: { companyId: company.id }, select: { id: true, name: true, email: true } }),
    prisma.externalHours.findFirst({ where: { companyId: company.id, system }, orderBy: { syncedAt: 'desc' }, select: { syncedAt: true } }),
  ])
  if (punches.length > MAX_ROWS) throw badRequest('That range holds too many segments. Narrow the dates.')

  const now = new Date()
  const cells = new Map<string, { personId: string; date: string; ours: number; theirs: number | null }>()
  const cell = (personId: string, date: string) => {
    const key = `${personId}|${date}`
    let c = cells.get(key)
    if (!c) {
      c = { personId, date, ours: 0, theirs: null }
      cells.set(key, c)
    }
    return c
  }
  for (const p of punches) cell(p.personId, localDate(p.clockIn, tz)).ours += hoursBetween(p.clockIn, p.clockOut, now)
  for (const t of theirs) cell(t.personId, t.date).theirs = t.hours

  const names = new Map(people.map((p) => [p.id, p]))
  const r2 = (n: number) => Math.round(n * 100) / 100
  const rows = [...cells.values()]
    .map((c) => {
      const ours = r2(c.ours)
      const diff = r2(ours - (c.theirs ?? 0))
      return {
        personId: c.personId,
        name: names.get(c.personId)?.name ?? '',
        email: names.get(c.personId)?.email ?? '',
        date: c.date,
        ours,
        theirs: c.theirs,
        diff,
        match: Math.abs(diff) < TOLERANCE_H,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.date.localeCompare(b.date))

  const byPerson = new Map<string, { personId: string; name: string; ours: number; theirs: number; diff: number; mismatchedDays: number }>()
  for (const r of rows) {
    const p = byPerson.get(r.personId) ?? { personId: r.personId, name: r.name, ours: 0, theirs: 0, diff: 0, mismatchedDays: 0 }
    p.ours += r.ours
    p.theirs += r.theirs ?? 0
    p.diff += r.diff
    if (!r.match) p.mismatchedDays += 1
    byPerson.set(r.personId, p)
  }

  return {
    system,
    from,
    to,
    toleranceHours: TOLERANCE_H,
    lastSyncedAt: lastSync?.syncedAt ?? null,
    totals: {
      ours: r2(rows.reduce((s, r) => s + r.ours, 0)),
      theirs: r2(rows.reduce((s, r) => s + (r.theirs ?? 0), 0)),
      days: rows.length,
      mismatchedDays: rows.filter((r) => !r.match).length,
    },
    people: [...byPerson.values()].map((p) => ({ ...p, ours: r2(p.ours), theirs: r2(p.theirs), diff: r2(p.diff) })),
    rows,
  }
}
