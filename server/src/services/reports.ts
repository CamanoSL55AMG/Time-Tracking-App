import { prisma } from '../db.js'
import { badRequest } from '../errors.js'
import { hoursBetween, localDate } from '../lib/time.js'

// Hours grouped by any mix of person / job / phase / day. A segment that runs past
// midnight is counted on the day it started.

export const GROUPS = ['person', 'job', 'phase', 'day'] as const
export type Group = (typeof GROUPS)[number]

const MAX_ROWS = 50_000

export interface HoursRow {
  personId?: string
  personName?: string
  jobId?: string
  jobName?: string
  jobCode?: string
  phaseKey?: string | null
  phaseName?: string
  day?: string
  hours: number
  segments: number
}

export async function hoursReport(
  companyId: string,
  opts: { from: Date; to: Date; groupBy: Group[]; personId?: string; jobId?: string },
) {
  if (opts.to.getTime() <= opts.from.getTime()) throw badRequest('to must be after from.')
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const punches = await prisma.punch.findMany({
    where: {
      companyId,
      clockIn: { gte: opts.from, lt: opts.to },
      personId: opts.personId,
      jobId: opts.jobId,
    },
    include: { job: true, phase: true, person: true },
    orderBy: { clockIn: 'asc' },
    take: MAX_ROWS + 1,
  })
  if (punches.length > MAX_ROWS) throw badRequest('That range holds too many segments. Narrow the dates.')

  const now = new Date()
  const groups = opts.groupBy.length ? opts.groupBy : (['person'] as Group[])
  const rows = new Map<string, HoursRow>()
  let total = 0

  for (const p of punches) {
    const day = localDate(p.clockIn, company.timezone)
    const key = groups
      .map((g) => (g === 'person' ? p.personId : g === 'job' ? p.jobId : g === 'phase' ? p.phaseId ?? '-' : day))
      .join('|')
    let row = rows.get(key)
    if (!row) {
      row = { hours: 0, segments: 0 }
      if (groups.includes('person')) Object.assign(row, { personId: p.personId, personName: p.person.name })
      if (groups.includes('job')) Object.assign(row, { jobId: p.jobId, jobName: p.job.name, jobCode: p.job.code })
      if (groups.includes('phase')) Object.assign(row, { phaseKey: p.phase?.key ?? null, phaseName: p.phase?.name ?? '' })
      if (groups.includes('day')) row.day = day
      rows.set(key, row)
    }
    const h = hoursBetween(p.clockIn, p.clockOut, now)
    row.hours += h
    row.segments += 1
    total += h
  }

  const round = (n: number) => Math.round(n * 100) / 100
  return {
    from: opts.from,
    to: opts.to,
    groupBy: groups,
    totalHours: round(total),
    rows: [...rows.values()].map((r) => ({ ...r, hours: round(r.hours) })),
  }
}
