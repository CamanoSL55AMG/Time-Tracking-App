import { prisma } from '../db.js'
import { badRequest } from '../errors.js'
import { hoursBetween, localDate } from '../lib/time.js'

// What each service call is invoiced, worked out from the punches. Morgan Sound's
// rule (the defaults on Company; decided 2026-10-21):
//   - one trip charge per service call (ticket). A different issue is its own
//     ticket, so it gets its own trip charge, even at the same site on the same trip;
//     a return visit on the same ticket does not;
//   - the trip charge covers the first hour on site of that first visit;
//   - travel to the call is billed as a flat 0.5 h per visit, whatever the drive took;
//   - on-site time past the included hour is billed in 15-minute steps;
//   - the drive to the next call belongs to the next call.
// That last rule falls out of how techs punch: "Drive to next call" opens the
// travel segment on the call they are driving to. A drive back to the shop is
// punched on the Shop job, and a drive home is its own phase: both are paid
// (commute from home counts as work time) and never billed.
// Payroll is untouched: people are paid the real time on their segments.

const TRAVEL_KEYS = new Set(['svc-travel', 'svc-parts'])
/** Paid, but never on the customer's invoice. */
const UNBILLED_KEYS = new Set(['svc-home'])

export interface ServiceCallRow {
  jobId: string
  jobName: string
  jobCode: string
  day: string
  techs: string[]
  actualTravelHours: number
  actualOnSiteHours: number
  billedTravelHours: number
  tripCharges: number
  includedHours: number
  billableHours: number
  /** True while someone is still on the clock on this call. */
  open: boolean
}

const GRACE_HOURS = 30 / 3600

const round2 = (n: number) => Math.round(n * 100) / 100

/** On-site hours past the included hour, rounded up to the billing step. */
export function billableOnSite(onSite: number, included: number, incrementMinutes: number): number {
  // Up to 30 seconds over a step boundary is not another step.
  const extra = onSite - included - GRACE_HOURS
  if (extra <= 0) return 0
  const step = Math.max(1, incrementMinutes) / 60
  return round2(Math.ceil(extra / step) * step)
}

export async function serviceBilling(companyId: string, opts: { from: Date; to: Date; jobId?: string }) {
  if (opts.to.getTime() <= opts.from.getTime()) throw badRequest('to must be after from.')
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const punches = await prisma.punch.findMany({
    where: { companyId, clockIn: { gte: opts.from, lt: opts.to }, jobId: opts.jobId, job: { kind: 'service' } },
    include: { job: true, phase: true, person: true },
    orderBy: { clockIn: 'asc' },
    take: 20_001,
  })
  if (punches.length > 20_000) throw badRequest('That range holds too many segments. Narrow the dates.')

  const now = new Date()
  const calls = new Map<string, ServiceCallRow & { travellers: Set<string> }>()
  for (const p of punches) {
    const day = localDate(p.clockIn, company.timezone)
    const key = `${p.jobId}|${day}`
    let c = calls.get(key)
    if (!c) {
      c = {
        jobId: p.jobId,
        jobName: p.job.name,
        jobCode: p.job.code,
        day,
        techs: [],
        actualTravelHours: 0,
        actualOnSiteHours: 0,
        billedTravelHours: 0,
        tripCharges: 0,
        includedHours: 0,
        billableHours: 0,
        open: false,
        travellers: new Set(),
      }
      calls.set(key, c)
    }
    if (!c.techs.includes(p.person.name)) c.techs.push(p.person.name)
    const h = hoursBetween(p.clockIn, p.clockOut, now)
    if (p.phase && UNBILLED_KEYS.has(p.phase.key)) {
      // Drive home: paid time, not billed.
    } else if (p.phase && TRAVEL_KEYS.has(p.phase.key)) {
      c.actualTravelHours += h
      c.travellers.add(p.personId)
    } else {
      c.actualOnSiteHours += h
    }
    if (!p.clockOut) c.open = true
  }

  // The first day each call was ever worked on (possibly before this range) is the
  // visit that carries its trip charge.
  const firsts = calls.size
    ? await prisma.punch.groupBy({ by: ['jobId'], where: { companyId, jobId: { in: [...new Set([...calls.values()].map((c) => c.jobId))] } }, _min: { clockIn: true } })
    : []
  const firstDay = new Map(firsts.map((f) => [f.jobId, f._min.clockIn ? localDate(f._min.clockIn, company.timezone) : '']))

  const rows: ServiceCallRow[] = [...calls.values()].map(({ travellers, ...c }) => {
    const firstVisit = firstDay.get(c.jobId) === c.day
    const tripCharges = firstVisit ? 1 : 0
    const included = firstVisit ? company.serviceIncludedHours : 0
    // Travel is billed per tech who drove there.
    const billedTravelHours = travellers.size * company.serviceTravelHours
    return {
      ...c,
      actualTravelHours: round2(c.actualTravelHours),
      actualOnSiteHours: round2(c.actualOnSiteHours),
      billedTravelHours: round2(billedTravelHours),
      tripCharges,
      includedHours: included,
      billableHours: billableOnSite(c.actualOnSiteHours, included, company.serviceIncrementMinutes),
    }
  })
  rows.sort((a, b) => a.day.localeCompare(b.day) || a.jobName.localeCompare(b.jobName))

  const sum = (f: (r: ServiceCallRow) => number) => round2(rows.reduce((s, r) => s + f(r), 0))
  return {
    from: opts.from,
    to: opts.to,
    rules: {
      travelHours: company.serviceTravelHours,
      includedHours: company.serviceIncludedHours,
      incrementMinutes: company.serviceIncrementMinutes,
    },
    rows,
    totals: {
      calls: rows.length,
      tripCharges: sum((r) => r.tripCharges),
      billedTravelHours: sum((r) => r.billedTravelHours),
      billableHours: sum((r) => r.billableHours),
      actualTravelHours: sum((r) => r.actualTravelHours),
      actualOnSiteHours: sum((r) => r.actualOnSiteHours),
    },
  }
}
