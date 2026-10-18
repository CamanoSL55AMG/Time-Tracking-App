import { prisma } from '../db.js'
import { hoursBetween, localDate } from '../lib/time.js'
import { insideFence, type Fence } from '../lib/geo.js'

// Things an approver should look at before signing off a week. "problem" needs a
// decision (a missed clock-out, a 14-hour day); "note" is context (a correction,
// a punch sent late from a phone with no signal).

export interface TimeException {
  code: 'missed_clock_out' | 'long_day' | 'away_from_site' | 'away_from_shop' | 'edited' | 'sent_late'
  severity: 'problem' | 'note'
  personId: string
  personName: string
  date: string
  punchId?: string
  message: string
}

const OPEN_TOO_LONG_H = 14
const LONG_DAY_H = 12
const LATE_AFTER_MIN = 30
// Phases spent on the road: a position away from the site is expected there.
const isTravel = (key: string | undefined) => Boolean(key && /travel|drive/i.test(key))

const timeOf = (d: Date, tz: string) => d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: tz })
const dayOf = (d: Date, tz: string) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: tz })

export async function findExceptions(companyId: string, opts: { from: Date; to: Date; personId?: string }): Promise<TimeException[]> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const tz = company.timezone
  const now = new Date()
  const shop: Fence | null = company.shopLat !== null && company.shopLng !== null ? { lat: company.shopLat, lng: company.shopLng, radiusM: company.shopRadiusM } : null

  const punches = await prisma.punch.findMany({
    where: {
      companyId,
      personId: opts.personId,
      // Segments starting in the range, plus anything still open from before it.
      OR: [{ clockIn: { gte: opts.from, lt: opts.to } }, { clockOut: null, clockIn: { lt: opts.to } }],
    },
    orderBy: { clockIn: 'asc' },
    include: {
      person: { select: { name: true } },
      job: true,
      phase: true,
      edits: { orderBy: { at: 'desc' }, take: 1 },
    },
  })
  const editorIds = [...new Set(punches.flatMap((p) => p.edits.map((e) => e.editedById)).filter((x): x is string => Boolean(x)))]
  const editors = new Map((await prisma.person.findMany({ where: { id: { in: editorIds } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]))

  const out: TimeException[] = []
  const dayTotals = new Map<string, { personId: string; personName: string; date: string; hours: number }>()

  for (const p of punches) {
    const date = localDate(p.clockIn, tz)
    const base = { personId: p.personId, personName: p.person.name, date, punchId: p.id }

    if (!p.clockOut && hoursBetween(p.clockIn, null, now) > OPEN_TOO_LONG_H) {
      out.push({ ...base, code: 'missed_clock_out', severity: 'problem', message: `Still on the clock since ${dayOf(p.clockIn, tz)} ${timeOf(p.clockIn, tz)} on ${p.job.name}. Missed clock-out?` })
    }

    if (p.clockIn >= opts.from) {
      const key = `${p.personId}|${date}`
      const t = dayTotals.get(key) ?? { personId: p.personId, personName: p.person.name, date, hours: 0 }
      t.hours += hoursBetween(p.clockIn, p.clockOut, now)
      dayTotals.set(key, t)
    }

    // Where the phone was at the punch. Office phases are worked anywhere.
    const geo = p.inLat !== null && p.inLng !== null ? { lat: p.inLat, lng: p.inLng, accuracyM: p.inAccuracyM ?? undefined } : null
    if (geo && p.phase && p.phase.dayFlow && !isTravel(p.phase.key)) {
      if (p.phase.atShop) {
        if (insideFence(geo, shop) === false) {
          out.push({ ...base, code: 'away_from_shop', severity: 'note', message: `"${p.phase.name}" punched away from the shop at ${timeOf(p.clockIn, tz)}.` })
        }
      } else {
        const site: Fence | null = p.job.siteLat !== null && p.job.siteLng !== null ? { lat: p.job.siteLat, lng: p.job.siteLng, radiusM: p.job.siteRadiusM ?? 200 } : null
        if (insideFence(geo, site) === false) {
          out.push({ ...base, code: 'away_from_site', severity: 'note', message: `"${p.phase.name}" on ${p.job.name} punched away from the job site at ${timeOf(p.clockIn, tz)}.` })
        }
      }
    }

    const last = p.edits[0]
    if (last) {
      const who = last.editedById ? editors.get(last.editedById) ?? 'someone' : 'an integration'
      out.push({ ...base, code: 'edited', severity: 'note', message: `${timeOf(p.clockIn, tz)} segment changed by ${who}: ${last.reason}` })
    } else if (p.createdAt.getTime() - p.clockIn.getTime() > LATE_AFTER_MIN * 60_000) {
      const mins = Math.round((p.createdAt.getTime() - p.clockIn.getTime()) / 60_000)
      const late = mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`
      out.push({ ...base, code: 'sent_late', severity: 'note', message: `${timeOf(p.clockIn, tz)} punch reached the server ${late} later (no signal, or entered after the fact).` })
    }
  }

  for (const t of dayTotals.values()) {
    if (t.hours > LONG_DAY_H) {
      out.push({ personId: t.personId, personName: t.personName, date: t.date, code: 'long_day', severity: 'problem', message: `${t.hours.toFixed(1)} h on ${dayOf(new Date(`${t.date}T12:00:00Z`), 'UTC')}.` })
    }
  }

  return out.sort((a, b) => a.date.localeCompare(b.date) || a.personName.localeCompare(b.personName) || (a.severity === b.severity ? 0 : a.severity === 'problem' ? -1 : 1))
}
