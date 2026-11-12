import { createHash } from 'node:crypto'
import { config } from '../config.js'
import { prisma } from '../db.js'
import { ApiError, badRequest } from '../errors.js'
import { addDays, isYmd, localDate, startOfLocalDay } from '../lib/time.js'
import { workerTypeOn, type HasWorkerType } from './workerType.js'

// Shop punches to Stage Forge (Kris Schmitt's spec, Nov 2026, item 1.1): Stage
// Forge shows Sound Services crew hours from its own shows and from the shop
// together, and it won't poll Logbook, so Logbook sends each finished punch
// segment of the Sound Services division to Stage Forge's POST /time-activities.
//
// Off unless STAGEFORGE_PUNCH_PUSH=true. Reporting only: pay and weekly overtime are
// worked out in AIC Accounting from Logbook's payroll export, not from this.
//
// Each segment goes once, and again only when it changes (a correction), carrying
// Logbook's punch id as StageForge.externalId and an Idempotency-Key, so Stage Forge
// can tell a resend from a new segment. The exact POST shape is still to be
// confirmed with Kris; this sends a QuickBooks-style TimeActivity like the ones
// Stage Forge already serves on GET /time-activities.

export interface PushPunch {
  id: string
  clockIn: Date
  clockOut: Date | null
  notes: string
  updatedAt: Date
  person: HasWorkerType & { id: string; name: string; email: string }
  job: { code: string; name: string; kind: string }
  phase: { key: string; name: string; laborCategory: string } | null
}

/** The TimeActivity sent for one finished segment. Pure; exported for tests. */
export function timeActivityFor(p: PushPunch, tz: string): Record<string, unknown> {
  if (!p.clockOut) throw new Error('A segment still open is not sent')
  const date = localDate(p.clockIn, tz)
  const minutesWorked = Math.max(0, Math.round((p.clockOut.getTime() - p.clockIn.getTime()) / 60_000))
  const job = [p.job.code, p.job.name].filter(Boolean).join(' ')
  return {
    TxnDate: date,
    NameOf: 'Employee',
    Hours: Math.floor(minutesWorked / 60),
    Minutes: minutesWorked % 60,
    StartTime: p.clockIn.toISOString(),
    EndTime: p.clockOut.toISOString(),
    Description: [job, p.phase?.name].filter(Boolean).join(' / ').slice(0, 300),
    StageForge: {
      source: 'logbook',
      externalId: p.id,
      email: p.person.email.toLowerCase(),
      personName: p.person.name,
      workerType: workerTypeOn(p.person, date) === 'contractor' ? 'contractor' : 'w2',
      jobCode: p.job.code,
      jobName: p.job.name,
      jobKind: p.job.kind,
      phase: p.phase?.key ?? '',
      laborCategory: p.phase?.laborCategory ?? '',
      // Paid through payroll from Logbook's hours, not by Stage Forge.
      payable: false,
    },
  }
}

export const payloadHash = (body: Record<string, unknown>): string =>
  createHash('sha256').update(JSON.stringify(body)).digest('hex')

/** Which segments to send: new ones, changed ones, and ones that failed before. Pure. */
export function planPush(
  items: { punchId: string; hash: string }[],
  sent: Map<string, { payloadHash: string; status: string }>,
): { send: string[]; unchanged: number } {
  const send: string[] = []
  let unchanged = 0
  for (const it of items) {
    const prev = sent.get(it.punchId)
    if (prev && prev.status === 'sent' && prev.payloadHash === it.hash) unchanged++
    else send.push(it.punchId)
  }
  return { send, unchanged }
}

export interface PushSettings {
  url: string
  key: string
  division: string
}

type Fetch = typeof fetch

export interface PushResult {
  from: string
  to: string
  dryRun: boolean
  segments: number
  unchanged: number
  sent: number
  failed: number
  failures: { punchId: string; error: string }[]
  /** On a dry run, what would be sent (first 50). */
  preview?: Record<string, unknown>[]
}

const MAX_SEGMENTS = 5000

/** Send the division's finished segments with clock-in from..to (company days). */
export async function pushShopPunches(
  companyId: string,
  opts: { from: string; to: string; dryRun: boolean },
  s: PushSettings = { url: config.stageforgeUrl, key: config.stageforgeKey, division: config.stageforgePunchDivision },
  fetchImpl: Fetch = fetch,
): Promise<PushResult> {
  if (!isYmd(opts.from) || !isYmd(opts.to)) throw badRequest('from and to must be dates, YYYY-MM-DD.', { fields: ['from', 'to'] })
  if (opts.to < opts.from) throw badRequest('to must be on or after from.')
  if ((Date.parse(`${opts.to}T00:00:00Z`) - Date.parse(`${opts.from}T00:00:00Z`)) / 86_400_000 > 62) {
    throw badRequest('Send at most 63 days at a time.')
  }
  if (!opts.dryRun && (!s.url || !s.key)) {
    throw new ApiError(403, 'stageforge_push_off', 'Sending punches to Stage Forge is turned off (STAGEFORGE_PUNCH_PUSH, STAGEFORGE_URL, STAGEFORGE_KEY).')
  }
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const tz = company.timezone
  const punches = await prisma.punch.findMany({
    where: {
      companyId,
      clockOut: { not: null },
      clockIn: { gte: startOfLocalDay(opts.from, tz), lt: startOfLocalDay(addDays(opts.to, 1), tz) },
      person: { companyId, division: { equals: s.division, mode: 'insensitive' } },
    },
    include: {
      person: { select: { id: true, name: true, email: true, workerType: true, workerTypeFrom: true, priorWorkerType: true } },
      job: { select: { code: true, name: true, kind: true } },
      phase: { select: { key: true, name: true, laborCategory: true } },
    },
    orderBy: { clockIn: 'asc' },
    take: MAX_SEGMENTS + 1,
  })
  if (punches.length > MAX_SEGMENTS) throw badRequest('That range holds too many segments. Narrow the dates.')

  const bodies = new Map(punches.map((p) => {
    const body = timeActivityFor(p as PushPunch, tz)
    return [p.id, { body, hash: payloadHash(body) }]
  }))
  const prior = await prisma.stageForgePush.findMany({ where: { companyId, punchId: { in: [...bodies.keys()] } } })
  const plan = planPush([...bodies].map(([punchId, b]) => ({ punchId, hash: b.hash })), new Map(prior.map((r) => [r.punchId, r])))

  const result: PushResult = {
    from: opts.from, to: opts.to, dryRun: opts.dryRun, segments: punches.length, unchanged: plan.unchanged, sent: 0, failed: 0, failures: [],
  }
  if (opts.dryRun) {
    result.preview = plan.send.slice(0, 50).map((id) => bodies.get(id)!.body)
    return result
  }

  const endpoint = `${s.url.replace(/\/+$/, '')}/time-activities`
  for (const punchId of plan.send) {
    const { body, hash } = bodies.get(punchId)!
    let status: 'sent' | 'failed' = 'failed'
    let error = ''
    let sfId: string | null = null
    try {
      const res = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${s.key}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Idempotency-Key': `logbook-${punchId}-${hash.slice(0, 16)}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
        redirect: 'manual',
      })
      const text = await res.text()
      if (res.ok) {
        status = 'sent'
        try {
          const j = JSON.parse(text) as Record<string, unknown>
          const ta = (j.TimeActivity ?? j) as Record<string, unknown>
          if (typeof ta.Id === 'string' || typeof ta.Id === 'number') sfId = String(ta.Id)
        } catch {
          // a 2xx without JSON is still accepted
        }
      } else {
        error = `Stage Forge answered ${res.status}${res.status === 401 || res.status === 403 ? ' (check STAGEFORGE_KEY)' : ''}: ${text.slice(0, 300)}`
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
    }
    await prisma.stageForgePush.upsert({
      where: { companyId_punchId: { companyId, punchId } },
      create: { companyId, punchId, payloadHash: hash, status, sfId, error, attempts: 1, sentAt: status === 'sent' ? new Date() : null },
      update: {
        payloadHash: hash, status, error, attempts: { increment: 1 },
        ...(sfId ? { sfId } : {}),
        ...(status === 'sent' ? { sentAt: new Date() } : {}),
      },
    })
    if (status === 'sent') result.sent++
    else {
      result.failed++
      if (result.failures.length < 20) result.failures.push({ punchId, error })
    }
  }
  return result
}

/** What has been sent, and what failed last. */
export async function pushStatus(companyId: string) {
  const [byStatus, failures, last] = await Promise.all([
    prisma.stageForgePush.groupBy({ by: ['status'], where: { companyId }, _count: { _all: true } }),
    prisma.stageForgePush.findMany({ where: { companyId, status: 'failed' }, orderBy: { updatedAt: 'desc' }, take: 20 }),
    prisma.stageForgePush.findFirst({ where: { companyId, status: 'sent' }, orderBy: { sentAt: 'desc' } }),
  ])
  return {
    enabled: config.stageforgePunchPush,
    division: config.stageforgePunchDivision,
    counts: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
    lastSentAt: last?.sentAt ?? null,
    failures: failures.map((f) => ({ punchId: f.punchId, error: f.error, attempts: f.attempts, at: f.updatedAt })),
  }
}

let running = false

/** Every few minutes, send the last two weeks' new and changed segments of every company. */
export function startStageForgePush(): void {
  if (!config.stageforgePunchPush) {
    console.log('[stageforge] Sending shop punches to Stage Forge is off (STAGEFORGE_PUNCH_PUSH not true).')
    return
  }
  const tick = async () => {
    if (running) return
    running = true
    try {
      for (const c of await prisma.company.findMany({ select: { id: true, timezone: true } })) {
        const to = localDate(new Date(), c.timezone)
        const r = await pushShopPunches(c.id, { from: addDays(to, -14), to, dryRun: false })
        if (r.sent || r.failed) console.log(`[stageforge] Punches sent: ${r.sent}, failed: ${r.failed}.`)
      }
    } catch (err) {
      console.error('[stageforge] Sending punches failed:', err)
    } finally {
      running = false
    }
  }
  console.log(`[stageforge] Sending ${config.stageforgePunchDivision} punches to Stage Forge every ${config.stageforgePushMinutes} min.`)
  setTimeout(() => void tick(), 20_000).unref()
  setInterval(() => void tick(), config.stageforgePushMinutes * 60_000).unref()
}
