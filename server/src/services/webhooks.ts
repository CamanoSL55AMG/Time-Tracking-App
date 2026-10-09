import { createHmac } from 'node:crypto'
import { prisma } from '../db.js'

// Outbound webhooks. A small loop in this process turns new events into deliveries
// and sends them. Each delivery is signed:
//   X-TT-Signature: sha256=<hex hmac of the raw body with the subscription secret>
// and retried with growing gaps for 24 hours. The receiver de-duplicates on the
// event id (also in X-TT-Event-Id): a delivery can arrive more than once.

const TICK_MS = 5_000
const TIMEOUT_MS = 10_000
const GIVE_UP_MS = 24 * 3_600_000
/** Gaps between attempts: 1 min, 5 min, 15 min, 1 h, then every 3 h until 24 h. */
const BACKOFF_MS = [60_000, 300_000, 900_000, 3_600_000, 10_800_000]
const BATCH = 50

export const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`

/** Turn events after each webhook's lastSeq into pending deliveries. */
async function enqueue(): Promise<void> {
  const hooks = await prisma.webhook.findMany({ where: { active: true } })
  for (const h of hooks) {
    const events = await prisma.event.findMany({
      where: { companyId: h.companyId, seq: { gt: h.lastSeq } },
      orderBy: { seq: 'asc' },
      take: 500,
      select: { seq: true, type: true },
    })
    if (!events.length) continue
    const wanted = events.filter((e) => !h.events.length || h.events.includes(e.type))
    await prisma.$transaction([
      prisma.webhookDelivery.createMany({ data: wanted.map((e) => ({ webhookId: h.id, eventSeq: e.seq })), skipDuplicates: true }),
      prisma.webhook.update({ where: { id: h.id }, data: { lastSeq: events[events.length - 1].seq } }),
    ])
  }
}

export interface Attempt {
  ok: boolean
  code: number | null
  error: string
}

/** POST one event to one URL. Never throws. */
export async function post(url: string, secret: string, event: { seq: number; type: string; at: Date; payload: unknown }, deliveryId: string): Promise<Attempt> {
  const body = JSON.stringify({ id: `evt_${event.seq}`, seq: event.seq, type: event.type, at: event.at, payload: event.payload })
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'TimeTracking-Webhooks/1',
        'X-TT-Event': event.type,
        'X-TT-Event-Id': `evt_${event.seq}`,
        'X-TT-Delivery': deliveryId,
        'X-TT-Signature': sign(secret, body),
      },
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    // Drain so the connection is released.
    await res.text().catch(() => '')
    return { ok: res.status >= 200 && res.status < 300, code: res.status, error: res.status >= 300 ? `HTTP ${res.status}` : '' }
  } catch (err) {
    return { ok: false, code: null, error: err instanceof Error ? err.message.slice(0, 300) : 'Request failed' }
  }
}

async function sendDue(): Promise<void> {
  const now = new Date()
  const due = await prisma.webhookDelivery.findMany({
    where: { status: 'pending', nextAt: { lte: now } },
    orderBy: [{ nextAt: 'asc' }],
    take: BATCH,
    include: { webhook: true },
  })
  for (const d of due) {
    if (!d.webhook.active) {
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'failed', lastError: 'Webhook switched off' } })
      continue
    }
    const event = await prisma.event.findUnique({ where: { seq: d.eventSeq } })
    if (!event) {
      await prisma.webhookDelivery.update({ where: { id: d.id }, data: { status: 'failed', lastError: 'Event no longer exists' } })
      continue
    }
    const r = await post(d.webhook.url, d.webhook.secret, event, d.id)
    const attempts = d.attempts + 1
    const gap = BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]
    const tooOld = Date.now() + gap - event.at.getTime() > GIVE_UP_MS
    await prisma.webhookDelivery.update({
      where: { id: d.id },
      data: {
        attempts,
        lastCode: r.code,
        lastError: r.error,
        status: r.ok ? 'ok' : tooOld ? 'failed' : 'pending',
        nextAt: r.ok || tooOld ? undefined : new Date(Date.now() + gap),
      },
    })
  }
}

let running = false
let timer: NodeJS.Timeout | null = null

export async function tick(): Promise<void> {
  if (running) return
  running = true
  try {
    await enqueue()
    await sendDue()
  } catch (err) {
    console.error('[webhooks]', err instanceof Error ? err.message : err)
  } finally {
    running = false
  }
}

export function startWebhooks(): void {
  if (timer) return
  timer = setInterval(() => void tick(), TICK_MS)
  timer.unref()
}

export function stopWebhooks(): void {
  if (timer) clearInterval(timer)
  timer = null
}
