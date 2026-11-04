import { createHash } from 'node:crypto'
import { prisma } from '../db.js'
import { badRequest } from '../errors.js'
import { addDays, isYmd, localDate, startOfLocalDay } from '../lib/time.js'
import { approvedThroughOf, weekOf } from './timesheets.js'

// Labor export for payroll. AIC Accounting reads it (GET /payroll/labor) and
// imports the hours to produce payroll.
//
// - Only approved weeks go out. A person with hours in the range whose week is not
//   approved yet is listed under notReady instead, so payroll can see who is missing.
// - Every labor type goes out: one line per person, day, job and phase (task), each
//   with the sold-labor category its phase rolls up to.
// - Overtime is worked out per workweek (Company.weekStartDay): hours past
//   Company.overtimeWeeklyHours, in the order they were worked, are overtime.
//   Washington has no daily overtime. 0 = no split. Exempt people get none.
// - Hours are the real punched time to the hundredth of an hour. No rounding rule
//   is applied here.
// - A segment that runs past midnight counts on the day it started, like every
//   other report. The pay period is whatever from/to the caller asks for.

const MAX_DAYS = 62
const MAX_SEGMENTS = 100_000

export interface WorkSegment {
  personId: string
  jobId: string
  phaseId: string | null
  clockIn: Date
  clockOut: Date
}

export interface SplitSegment<S extends WorkSegment = WorkSegment> {
  segment: S
  regularSeconds: number
  overtimeSeconds: number
}

/**
 * Splits one person's workweek into regular and overtime seconds. Segments are
 * taken in the order they were worked; whatever falls past `thresholdHours`
 * is overtime. thresholdHours <= 0 or exempt = all regular.
 */
export function splitWorkweek<S extends WorkSegment>(segments: S[], thresholdHours: number, exempt = false): SplitSegment<S>[] {
  const sorted = [...segments].sort((a, b) => a.clockIn.getTime() - b.clockIn.getTime())
  const limit = !exempt && thresholdHours > 0 ? thresholdHours * 3600 : Infinity
  let worked = 0
  return sorted.map((segment) => {
    const seconds = Math.max(0, (segment.clockOut.getTime() - segment.clockIn.getTime()) / 1000)
    const regularSeconds = Math.max(0, Math.min(seconds, limit - worked))
    worked += seconds
    return { segment, regularSeconds, overtimeSeconds: seconds - regularSeconds }
  })
}

const hundredths = (seconds: number) => Math.round((seconds / 3600) * 100) / 100

/** Stable id for a line, so a re-export of the same period carries the same ids. */
export const lineIdOf = (personId: string, date: string, jobId: string, phaseId: string | null) =>
  createHash('sha256').update(`${personId}|${date}|${jobId}|${phaseId ?? '-'}`).digest('hex').slice(0, 24)

export interface LaborLine {
  lineId: string
  personId: string
  personEmail: string
  personName: string
  overtimeExempt: boolean
  date: string
  weekStart: string
  jobId: string
  jobCode: string
  jobName: string
  jobKind: string
  phaseKey: string
  phaseName: string
  laborCategory: string
  regularHours: number
  overtimeHours: number
  hours: number
  segments: number
}

export interface NotReady {
  personId: string
  personName: string
  personEmail: string
  weekStart: string
  status: string // open | signed | approved (approved but someone is still on the clock)
  /** Set when part of the week is approved: the days after this one aren't yet. */
  approvedThrough?: string
  hours: number
}

export async function laborExport(companyId: string, from: string, to: string) {
  if (!isYmd(from) || !isYmd(to)) throw badRequest('from and to must be dates, YYYY-MM-DD.', { fields: ['from', 'to'] })
  if (to < from) throw badRequest('to must be on or after from.')
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1
  if (days > MAX_DAYS) throw badRequest(`A pay period can be at most ${MAX_DAYS} days.`)

  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const tz = company.timezone
  // Whole workweeks around the range, so overtime counts every hour of each week
  // even when the pay period ends mid-week.
  const firstWeek = weekOf(from, company.weekStartDay)
  const lastWeek = weekOf(to, company.weekStartDay)
  const weeks: string[] = []
  for (let w = firstWeek; w <= lastWeek; w = addDays(w, 7)) weeks.push(w)

  const [punches, sheets] = await Promise.all([
    prisma.punch.findMany({
      where: { companyId, clockIn: { gte: startOfLocalDay(firstWeek, tz), lt: startOfLocalDay(addDays(lastWeek, 7), tz) } },
      include: {
        person: { select: { id: true, name: true, email: true, overtimeExempt: true } },
        job: { select: { id: true, name: true, code: true, kind: true } },
        phase: { select: { id: true, key: true, name: true, laborCategory: true } },
      },
      orderBy: { clockIn: 'asc' },
      take: MAX_SEGMENTS + 1,
    }),
    prisma.timesheet.findMany({ where: { companyId, weekStart: { in: weeks } } }),
  ])
  if (punches.length > MAX_SEGMENTS) throw badRequest('That range holds too many segments. Narrow the dates.')

  const sheetOf = new Map(sheets.map((s) => [`${s.personId}|${s.weekStart}`, s]))
  const inRange = (d: string) => d >= from && d <= to

  type P = (typeof punches)[number]
  const byWeek = new Map<string, P[]>()
  for (const p of punches) {
    const key = `${p.personId}|${weekOf(localDate(p.clockIn, tz), company.weekStartDay)}`
    const list = byWeek.get(key) ?? []
    list.push(p)
    byWeek.set(key, list)
  }

  const lines = new Map<string, LaborLine & { regularSeconds: number; overtimeSeconds: number }>()
  const notReady: NotReady[] = []
  const now = new Date()

  for (const [key, segs] of byWeek) {
    const [personId, weekStart] = key.split('|')
    const person = segs[0].person
    const inPeriod = segs.filter((s) => inRange(localDate(s.clockIn, tz)))
    if (!inPeriod.length) continue
    const sheet = sheetOf.get(key)
    const status = sheet?.status ?? 'open'
    // Approvers can sign off part of a week (through the 15th or month end). Only the
    // days the approval covers go out; the rest wait. Overtime is split in the order
    // worked, so the covered days come out the same as they will once the week is done.
    const through = approvedThroughOf(sheet)
    const covered = through ? segs.filter((s) => localDate(s.clockIn, tz) <= through) : []
    const waiting = inPeriod.filter((s) => !through || localDate(s.clockIn, tz) > through)
    const open = covered.some((s) => !s.clockOut)
    const secondsOf = (list: P[]) => list.reduce((t, s) => t + ((s.clockOut ?? now).getTime() - s.clockIn.getTime()) / 1000, 0)
    if (!through || open) {
      notReady.push({ personId, personName: person.name, personEmail: person.email, weekStart, status, hours: hundredths(secondsOf(inPeriod)) })
      continue
    }
    if (waiting.length) {
      notReady.push({ personId, personName: person.name, personEmail: person.email, weekStart, status: 'open', approvedThrough: through, hours: hundredths(secondsOf(waiting)) })
    }
    const closed = covered.map((s) => ({ ...s, clockOut: s.clockOut as Date }))
    for (const { segment: s, regularSeconds, overtimeSeconds } of splitWorkweek(closed, company.overtimeWeeklyHours, person.overtimeExempt)) {
      const date = localDate(s.clockIn, tz)
      if (!inRange(date)) continue
      const lineId = lineIdOf(personId, date, s.jobId, s.phaseId)
      let line = lines.get(lineId)
      if (!line) {
        line = {
          lineId,
          personId,
          personEmail: person.email,
          personName: person.name,
          overtimeExempt: person.overtimeExempt,
          date,
          weekStart,
          jobId: s.jobId,
          jobCode: s.job.code,
          jobName: s.job.name,
          jobKind: s.job.kind,
          phaseKey: s.phase?.key ?? '',
          phaseName: s.phase?.name ?? '',
          // A segment with no phase counts as install, as in the hours report.
          laborCategory: s.phase?.laborCategory || 'install',
          regularHours: 0,
          overtimeHours: 0,
          hours: 0,
          segments: 0,
          regularSeconds: 0,
          overtimeSeconds: 0,
        }
        lines.set(lineId, line)
      }
      line.regularSeconds += regularSeconds
      line.overtimeSeconds += overtimeSeconds
      line.segments += 1
    }
  }

  const out: LaborLine[] = [...lines.values()]
    .map(({ regularSeconds, overtimeSeconds, ...l }) => {
      const regularHours = hundredths(regularSeconds)
      const overtimeHours = hundredths(overtimeSeconds)
      return { ...l, regularHours, overtimeHours, hours: Math.round((regularHours + overtimeHours) * 100) / 100 }
    })
    .filter((l) => l.hours > 0)
    .sort((a, b) => a.personName.localeCompare(b.personName) || a.date.localeCompare(b.date) || a.jobCode.localeCompare(b.jobCode) || a.phaseKey.localeCompare(b.phaseKey))

  const totals = new Map<string, { personId: string; personEmail: string; personName: string; regularHours: number; overtimeHours: number; hours: number }>()
  for (const l of out) {
    const t = totals.get(l.personId) ?? { personId: l.personId, personEmail: l.personEmail, personName: l.personName, regularHours: 0, overtimeHours: 0, hours: 0 }
    t.regularHours += l.regularHours
    t.overtimeHours += l.overtimeHours
    t.hours += l.hours
    totals.set(l.personId, t)
  }
  const r2 = (n: number) => Math.round(n * 100) / 100

  return {
    from,
    to,
    timezone: tz,
    weekStartDay: company.weekStartDay,
    overtimeWeeklyHours: company.overtimeWeeklyHours,
    generatedAt: now.toISOString(),
    lines: out,
    totals: [...totals.values()].map((t) => ({ ...t, regularHours: r2(t.regularHours), overtimeHours: r2(t.overtimeHours), hours: r2(t.hours) })),
    notReady: notReady.sort((a, b) => a.personName.localeCompare(b.personName) || a.weekStart.localeCompare(b.weekStart)),
  }
}

// ─── Pay periods ────────────────────────────────────────────────────────────

/**
 * Morgan Sound runs payroll twice a month: the 1st to the 15th, and the 16th to the
 * last day of the month. Overtime is still counted by the Monday to Sunday week, so a
 * week that crosses a period end splits: its hours in each period keep the overtime
 * they earned in the order worked (see splitWorkweek).
 */
export function semimonthlyPeriod(date: string): { from: string; to: string } {
  const [y, m, d] = date.split('-').map(Number)
  const mm = String(m).padStart(2, '0')
  if (d <= 15) return { from: `${y}-${mm}-01`, to: `${y}-${mm}-15` }
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: `${y}-${mm}-16`, to: `${y}-${mm}-${String(last).padStart(2, '0')}` }
}

export function previousSemimonthlyPeriod(date: string): { from: string; to: string } {
  return semimonthlyPeriod(addDays(semimonthlyPeriod(date).from, -1))
}

// ─── CSV ────────────────────────────────────────────────────────────────────

export const CSV_COLUMNS = [
  'line_id',
  'employee_email',
  'employee_name',
  'date',
  'week_start',
  'job_code',
  'job_name',
  'job_kind',
  'phase',
  'labor_category',
  'regular_hours',
  'overtime_hours',
  'hours',
] as const

const cell = (v: string | number): string => {
  let s = String(v)
  // A leading = + - @ makes spreadsheets run the cell as a formula.
  if (/^[=+\-@]/.test(s) && typeof v === 'string') s = `'${s}`
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** The export as a CSV file, one line per row of `lines`, same columns AIC Accounting imports. */
export function laborCsv(lines: LaborLine[]): string {
  const rows = lines.map((l) =>
    [l.lineId, l.personEmail, l.personName, l.date, l.weekStart, l.jobCode, l.jobName, l.jobKind, l.phaseName || l.phaseKey, l.laborCategory, l.regularHours.toFixed(2), l.overtimeHours.toFixed(2), l.hours.toFixed(2)]
      .map(cell)
      .join(','),
  )
  return [CSV_COLUMNS.join(','), ...rows].join('\r\n') + '\r\n'
}
