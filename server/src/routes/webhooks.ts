import { Router } from 'express'
import { randomBytes } from 'node:crypto'
import type { Webhook } from '@prisma/client'
import { prisma } from '../db.js'
import { bool, limitOf, requiredStr, route } from '../api.js'
import { badRequest, notFound } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { EVENT_TYPES } from '../services/events.js'
import { post } from '../services/webhooks.js'

export const webhooksRouter = Router()

const view = (w: Webhook) => ({ id: w.id, url: w.url, events: w.events, active: w.active, lastSeq: w.lastSeq, createdAt: w.createdAt })

function checkUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw badRequest('url is not a valid address.', { field: 'url' })
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw badRequest('Webhooks are sent over https (plain http only to localhost, for testing).', { field: 'url' })
  }
  return u.toString()
}

function checkEvents(v: unknown): string[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw badRequest('events must be an array.', { field: 'events', available: EVENT_TYPES })
  for (const e of v) if (!(EVENT_TYPES as string[]).includes(String(e))) throw badRequest(`Unknown event type "${String(e)}".`, { field: 'events', available: EVENT_TYPES })
  return [...new Set(v.map(String))]
}

const find = async (companyId: string, id: string) => {
  const w = await prisma.webhook.findFirst({ where: { id, companyId } })
  if (!w) throw notFound('Webhook')
  return w
}

route(
  webhooksRouter,
  { method: 'get', path: '/webhooks', tag: 'Integration', summary: 'Outbound webhook subscriptions. Secrets are never shown again after creation.', access: ['webhooks:manage'] },
  async (req) => {
    const auth = requireScope(req, 'webhooks:manage')
    const hooks = await prisma.webhook.findMany({ where: { companyId: auth.companyId }, orderBy: { createdAt: 'desc' } })
    const stats = await prisma.webhookDelivery.groupBy({ by: ['webhookId', 'status'], where: { webhookId: { in: hooks.map((h) => h.id) } }, _count: true })
    return {
      data: hooks.map((h) => ({
        ...view(h),
        delivered: stats.find((s) => s.webhookId === h.id && s.status === 'ok')?._count ?? 0,
        pending: stats.find((s) => s.webhookId === h.id && s.status === 'pending')?._count ?? 0,
        failed: stats.find((s) => s.webhookId === h.id && s.status === 'failed')?._count ?? 0,
      })),
      eventTypes: EVENT_TYPES,
    }
  },
)

route(
  webhooksRouter,
  {
    method: 'post',
    path: '/webhooks',
    tag: 'Integration',
    summary: 'Subscribe a URL to events from now on. The response is the only time the signing secret is shown.',
    access: ['webhooks:manage'],
    status: 201,
    body: { url: 'https address that accepts POST', events: `Array of event types; empty or missing for all. One of: ${EVENT_TYPES.join(', ')}` },
  },
  async (req) => {
    const auth = requireScope(req, 'webhooks:manage')
    const url = checkUrl(requiredStr(req.body?.url, 'url', 1000))
    const events = checkEvents(req.body?.events)
    const last = await prisma.event.findFirst({ where: { companyId: auth.companyId }, orderBy: { seq: 'desc' }, select: { seq: true } })
    const secret = `whsec_${randomBytes(24).toString('base64url')}`
    const w = await prisma.webhook.create({ data: { companyId: auth.companyId, url, events, secret, lastSeq: last?.seq ?? 0 } })
    return { webhook: view(w), secret }
  },
)

route(
  webhooksRouter,
  {
    method: 'patch',
    path: '/webhooks/:id',
    tag: 'Integration',
    summary: 'Change the URL or event list, or switch a webhook off and on.',
    access: ['webhooks:manage'],
    body: { url: 'New address', events: 'New event list', active: 'false to pause' },
  },
  async (req) => {
    const auth = requireScope(req, 'webhooks:manage')
    const w = await find(auth.companyId, req.params.id)
    const b = (req.body ?? {}) as Record<string, unknown>
    const active = bool(b.active)
    const turningOn = active === true && !w.active
    const last = turningOn ? await prisma.event.findFirst({ where: { companyId: auth.companyId }, orderBy: { seq: 'desc' }, select: { seq: true } }) : null
    const updated = await prisma.webhook.update({
      where: { id: w.id },
      data: {
        url: b.url === undefined ? undefined : checkUrl(requiredStr(b.url, 'url', 1000)),
        events: b.events === undefined ? undefined : checkEvents(b.events),
        active,
        // Back on: start from now rather than replaying everything missed while off.
        lastSeq: turningOn ? last?.seq ?? w.lastSeq : undefined,
      },
    })
    return { webhook: view(updated) }
  },
)

route(
  webhooksRouter,
  { method: 'delete', path: '/webhooks/:id', tag: 'Integration', summary: 'Remove a subscription and its delivery history.', access: ['webhooks:manage'] },
  async (req) => {
    const auth = requireScope(req, 'webhooks:manage')
    const w = await find(auth.companyId, req.params.id)
    await prisma.webhook.delete({ where: { id: w.id } })
    return { ok: true }
  },
)

route(
  webhooksRouter,
  {
    method: 'post',
    path: '/webhooks/:id/test',
    tag: 'Integration',
    summary: 'Send a webhook.test event to this URL now and report what came back.',
    access: ['webhooks:manage'],
  },
  async (req) => {
    const auth = requireScope(req, 'webhooks:manage')
    const w = await find(auth.companyId, req.params.id)
    const result = await post(w.url, w.secret, { seq: 0, type: 'webhook.test', at: new Date(), payload: { webhookId: w.id } }, `test_${randomBytes(6).toString('hex')}`)
    return { result }
  },
)

route(
  webhooksRouter,
  {
    method: 'get',
    path: '/webhooks/:id/deliveries',
    tag: 'Integration',
    summary: 'Recent deliveries for one webhook, newest first.',
    access: ['webhooks:manage'],
    query: { status: 'pending | ok | failed', limit: 'Page size, 100 by default' },
  },
  async (req) => {
    const auth = requireScope(req, 'webhooks:manage')
    const w = await find(auth.companyId, req.params.id)
    const status = ['pending', 'ok', 'failed'].includes(String(req.query.status)) ? String(req.query.status) : undefined
    const rows = await prisma.webhookDelivery.findMany({
      where: { webhookId: w.id, status },
      orderBy: { eventSeq: 'desc' },
      take: limitOf(req.query.limit),
    })
    const events = await prisma.event.findMany({ where: { seq: { in: rows.map((r) => r.eventSeq) } }, select: { seq: true, type: true } })
    const types = new Map(events.map((e) => [e.seq, e.type]))
    return { data: rows.map((r) => ({ ...r, eventType: types.get(r.eventSeq) ?? '' })) }
  },
)

route(
  webhooksRouter,
  {
    method: 'post',
    path: '/webhooks/:id/retry',
    tag: 'Integration',
    summary: 'Send every failed delivery for this webhook again.',
    access: ['webhooks:manage'],
  },
  async (req) => {
    const auth = requireScope(req, 'webhooks:manage')
    const w = await find(auth.companyId, req.params.id)
    const r = await prisma.webhookDelivery.updateMany({ where: { webhookId: w.id, status: 'failed' }, data: { status: 'pending', nextAt: new Date(), attempts: 0 } })
    return { requeued: r.count }
  },
)
