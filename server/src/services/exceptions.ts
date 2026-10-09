import type { Company } from '@prisma/client'
import { prisma } from '../db.js'
import { badRequest } from '../errors.js'
import { hoursBetween, localDate, startOfLocalDay, addDays } from '../lib/time.js'
import { distanceM, type GeoStamp } from '../lib/geo.js'

// Things a manager should look at before approving a week. Nothing here blocks a
// punch; it is a list to review. "warn" items deserve a look, "info" items are
// there so nothing is hidden (who entered or changed a segment, and why).

export type ExceptionType =
  | 'open_long' // still on the clock after many hours: forgot to clock out?
  | 'long_day' // more than LONG_DAY_H hours in one day
  | 'short_segment' // a segment of a minute or two: a double tap?
  | 'off_site' // punched in away from the job site (or away from the shop for a shop phase)
  | 'no_location' // punched from the app with no position
  | 'scheduled_no_time' // on the calendar for a job, no time that day
  | 'edited' // changed after the fact
  | 'entered_by_other' // put in by a lead or a manager

export interface TimeException {
  type: ExceptionType
  severity: 'warn' | 'info'
  personId: string
  personName: string
  date: string
  punchId?: string
  message: string
  details?: Record<string, unknown>
}

export const OPEN_LONG_H = 12
export const LONG_DAY_H = 12
export const SHORT_SEGMENT_MIN = 2
/** A job site with a pin but no radius set. */
export const DEFAULT_SITE_RADIUS_M = 200
/** GPS on a phone is often off by this much; a fence is only judged past it. */
const ACCURACY_ALLOWANCE_M = 100

const MAX_ROWS = 20_000

const stamp = (lat: number | null, lng: number | null, acc: number | null): GeoStamp | null =>
  lat !== null && lng !== null ? { lat, lng, accuracyM: acc ?? undefined } : null

/** How far outside a fence a stamp is, allowing for its accuracy. 0 when inside or unknown. */
function metresOutside(s: GeoStamp | null, lat: number | null, lng: number | null, radiusM: number | null): number {
  if (!s || lat === null || lng === null || radiusM === null) return 0
  const d = distanceM(s, { lat, lng })
  return Math.max(0, d - radiusM - Math.min(s.accuracyM ?? 0, ACCURACY_ALLOWANCE_M))
}

export async function findExceptions(
  company: Company,
  opts: { from: string; to: string; personId?: string },
): Promise<TimeException[]> {
  if (opts.to < opts.from) throw badRequest('to must be on or after from.')
  const tz = company.timezone
  const start = startOfLocalDay(opts.from, tz)
  const end = startOfLocalDay(addDays(opts.to, 1), tz)
  const now = new Date()
  const today = localDate(now, tz)

  const [punches, assignments] = await Promise.all([
    prisma.punch.findMany({
      where: { companyId: company.id, personId: opts.personId, clockIn: { gte: start, lt: end } },
      include: {
        person: { select: { name: true } },
        job: true,
        phase: true,
        edits: { orderBy: { at: 'asc' } },
      },
      orderBy: { clockIn: 'asc' },
      take: MAX_ROWS + 1,
    }),
    prisma.assignment.findMany({
      where: { companyId: company.id, personId: opts.personId, date: { gte: opts.from, lte: opts.to }, jobId: { not: null } },
      include: { person: { select: { name: true } }, job: true },
    }),
  ])
  if (punches.length > MAX_ROWS) throw badRequest('That range holds too many segments. Narrow the dates.')

  // Names of whoever changed or entered something, for the messages.
  const editorIds = new Set<string>()
  for (const p of punches) {
    if (p.enteredById) editorIds.add(p.enteredById)
    for (const e of p.edits) if (e.editedById) editorIds.add(e.editedById)
  }
  const editors = new Map(
    (await prisma.person.findMany({ where: { id: { in: [...editorIds] } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]),
  )
  const who = (id: string | null) => (id ? editors.get(id) ?? 'someone' : 'an integration')

  const out: TimeException[] = []
  const dayHours = new Map<string, { personId: string; personName: string; date: string; hours: number }>()

  for (const p of punches) {
    const date = localDate(p.clockIn, tz)
    const base = { personId: p.personId, personName: p.person.name, date, punchId: p.id }
    const hours = hoursBetween(p.clockIn, p.clockOut, now)

    const key = `${p.personId}|${date}`
    const d = dayHours.get(key) ?? { personId: p.personId, personName: p.person.name, date, hours: 0 }
    d.hours += hours
    dayHours.set(key, d)

    if (!p.clockOut && hours >= OPEN_LONG_H) {
      out.push({ ...base, type: 'open_long', severity: 'warn', message: `Still on the clock after ${Math.floor(hours)} hours. Forgot to clock out?`, details: { hours } })
    }
    if (p.clockOut && hours * 60 < SHORT_SEGMENT_MIN) {
      out.push({ ...base, type: 'short_segment', severity: 'info', message: `${p.phase?.name ?? 'Segment'} lasted under ${SHORT_SEGMENT_MIN} minutes.` })
    }

    const inAt = stamp(p.inLat, p.inLng, p.inAccuracyM)
    if (!inAt && p.source === 'app') {
      out.push({ ...base, type: 'no_location', severity: 'info', message: 'Punched in without a location.' })
    }
    if (inAt) {
      const shopPhase = p.phase?.atShop === true
      const off = shopPhase
        ? metresOutside(inAt, company.shopLat, company.shopLng, company.shopRadiusM)
        : metresOutside(inAt, p.job.siteLat, p.job.siteLng, p.job.siteRadiusM ?? DEFAULT_SITE_RADIUS_M)
      // Travel phases are expected to start anywhere.
      const travel = p.phase?.key.startsWith('travel') ?? false
      if (off > 0 && !travel) {
        out.push({
          ...base,
          type: 'off_site',
          severity: 'warn',
          message: `${p.phase?.name ?? 'Punch'} started about ${fmtDistance(off)} outside ${shopPhase ? 'the shop' : p.job.name}.`,
          details: { metresOutside: Math.round(off), lat: inAt.lat, lng: inAt.lng },
        })
      }
    }

    if (p.source === 'lead' || p.source === 'edit') {
      out.push({
        ...base,
        type: 'entered_by_other',
        severity: 'info',
        message: p.source === 'lead' ? `Punched by ${who(p.enteredById)} for the crew.` : `Added by ${who(p.enteredById)}.`,
      })
    }
    for (const e of p.edits) {
      // An "added" segment's first record is its creation, already reported above.
      if (p.source === 'edit' && e === p.edits[0]) continue
      out.push({ ...base, type: 'edited', severity: 'info', message: `Changed by ${who(e.editedById)}: ${e.reason}`, details: { at: e.at } })
    }
  }

  for (const d of dayHours.values()) {
    if (d.hours > LONG_DAY_H) {
      out.push({ personId: d.personId, personName: d.personName, date: d.date, type: 'long_day', severity: 'warn', message: `${d.hours.toFixed(1)} hours in one day.`, details: { hours: d.hours } })
    }
  }

  // On the calendar for a job, but no time at all that day. Today is not judged yet.
  for (const a of assignments) {
    if (a.date >= today || dayHours.has(`${a.personId}|${a.date}`)) continue
    out.push({
      personId: a.personId,
      personName: a.person.name,
      date: a.date,
      type: 'scheduled_no_time',
      severity: 'warn',
      message: `On the schedule for ${a.job?.name ?? a.title} but no time was recorded.`,
    })
  }

  // One message per scheduled day is enough even if two calendar entries named it.
  const seen = new Set<string>()
  return out
    .filter((e) => {
      if (e.type !== 'scheduled_no_time') return true
      const k = `${e.personId}|${e.date}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.personName.localeCompare(b.personName) || Number(a.severity === 'info') - Number(b.severity === 'info'))
}

const fmtDistance = (m: number) => (m >= 1000 ? `${(m / 1609.344).toFixed(1)} miles` : `${Math.round(m)} m`)
