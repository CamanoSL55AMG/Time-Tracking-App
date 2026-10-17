import { prisma } from '../db.js'
import { addDays } from '../lib/time.js'
import { accrueThrough, todayIn, yearEnd } from './leave.js'

// Once a day per company (checked hourly): accrue leave through the week that
// ended a week ago, and in January apply last year's carryover limits. Both are
// safe to repeat, so a restart or a second server does no harm.

const lastRun = new Map<string, string>()

export async function runNightly(): Promise<void> {
  const companies = await prisma.company.findMany({ select: { id: true, name: true, timezone: true } })
  for (const c of companies) {
    const today = todayIn(c.timezone)
    if (lastRun.get(c.id) === today) continue
    try {
      const accrued = await accrueThrough(c.id, addDays(today, -8))
      if (accrued.entries) console.log(`[leave] ${c.name}: ${accrued.entries} accrual entries, ${accrued.hours} h, through ${accrued.through}`)
      if (today.slice(5, 7) === '01') {
        const ye = await yearEnd(c.id, Number(today.slice(0, 4)) - 1)
        if (ye.entries) console.log(`[leave] ${c.name}: year end ${ye.year}, ${ye.hoursForfeited} h above carryover limits`)
      }
      lastRun.set(c.id, today)
    } catch (err) {
      console.error(`[leave] nightly run for ${c.name} failed; will retry next hour`, err)
    }
  }
}

export function startNightly(): () => void {
  if ((process.env.LEAVE_AUTO_ACCRUE ?? 'true').toLowerCase() === 'false') return () => undefined
  const tick = () => void runNightly().catch((err) => console.error('[leave] nightly', err))
  const first = setTimeout(tick, 30_000) // let the server settle after start
  const every = setInterval(tick, 60 * 60_000)
  return () => {
    clearTimeout(first)
    clearInterval(every)
  }
}
