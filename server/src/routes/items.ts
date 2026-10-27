import { Router } from 'express'
import { prisma } from '../db.js'
import { route, str } from '../api.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requirePerson, requireScope } from '../auth/middleware.js'
import { SELF } from '../auth/apiKeys.js'
import { emit } from '../services/events.js'
import { hoursBetween } from '../lib/time.js'
import { openItemsFor } from '../services/punch.js'

// ─── Open items ─────────────────────────────────────────────────────────────
// Service tickets and Shop / Office / CAD tasks a person has open. They open with
// the first punch on a job in that mode (services/punch.ts) and stay open across
// switches until the person closes them, usually at the end of the day.

export const itemsRouter = Router()

/** Reasons offered for leaving an item open overnight; any other text is accepted too. */
export const KEEP_REASONS = ['Waiting on parts', 'Return visit scheduled', 'Needs the office', 'Continue tomorrow']

route(
  itemsRouter,
  { method: 'get', path: '/me/items', tag: 'Open items', summary: 'Your open service tickets and tasks, with hours so far.', access: [SELF] },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    const open = await prisma.punch.findFirst({ where: { personId: person.id, clockOut: null }, select: { workItemId: true } })
    return { data: await openItemsFor(person.id, open?.workItemId ?? null), keepReasons: KEEP_REASONS }
  },
)

async function ownItem(personId: string, companyId: string, id: string) {
  const item = await prisma.workItem.findFirst({ where: { id, companyId } })
  if (!item) throw notFound('Item')
  if (item.personId !== personId) throw forbidden('That item belongs to someone else.')
  if (item.status !== 'open') throw conflict('item_closed', 'That item is already closed.')
  return item
}

route(
  itemsRouter,
  {
    method: 'post',
    path: '/me/items/:id/close',
    tag: 'Open items',
    summary: 'Close a service ticket or task, with what was done.',
    access: [SELF],
    body: { resolution: 'What was done (required), e.g. "replaced amp, tested OK"' },
  },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const resolution = str(req.body?.resolution, 1000)
    if (!resolution) throw badRequest('Say what was done before closing it.', { field: 'resolution' })
    const item = await ownItem(person.id, auth.companyId, req.params.id)
    const closed = await prisma.$transaction(async (tx) => {
      const c = await tx.workItem.update({
        where: { id: item.id },
        data: { status: 'closed', resolution, waitingReason: '', closedAt: new Date(), closedById: person.id },
        include: { job: true },
      })
      await emit(tx, auth.companyId, 'item.closed', { id: c.id, personId: c.personId, jobId: c.jobId, jobCode: c.job.code, mode: c.mode, resolution })
      return c
    })
    return { item: closed }
  },
)

route(
  itemsRouter,
  {
    method: 'post',
    path: '/me/items/:id/keep',
    tag: 'Open items',
    summary: 'Leave a service ticket or task open, saying why (waiting on parts, return visit…).',
    access: [SELF],
    body: { reason: `Why it stays open (required): ${KEEP_REASONS.join(', ')}, or your own words` },
  },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const reason = str(req.body?.reason, 300)
    if (!reason) throw badRequest('Say why it stays open.', { field: 'reason' })
    const item = await ownItem(person.id, auth.companyId, req.params.id)
    const kept = await prisma.$transaction(async (tx) => {
      const k = await tx.workItem.update({ where: { id: item.id }, data: { waitingReason: reason }, include: { job: true } })
      await emit(tx, auth.companyId, 'item.kept', { id: k.id, personId: k.personId, jobId: k.jobId, jobCode: k.job.code, mode: k.mode, reason })
      return k
    })
    return { item: kept }
  },
)

route(
  itemsRouter,
  {
    method: 'get',
    path: '/items',
    tag: 'Open items',
    summary: "Everyone's open service tickets and tasks, oldest first: who, what, how long, why it is still open.",
    access: ['punch:read'],
    query: { status: 'open (default) or closed', mode: 'Only service, shop, office or cad' },
  },
  async (req) => {
    const auth = requireScope(req, 'punch:read')
    const status = str(req.query.status, 10) || 'open'
    if (status !== 'open' && status !== 'closed') throw badRequest('status must be open or closed.', { field: 'status' })
    const mode = str(req.query.mode, 10) || undefined
    const now = new Date()
    const items = await prisma.workItem.findMany({
      where: { companyId: auth.companyId, status, mode },
      orderBy: status === 'open' ? { openedAt: 'asc' } : { closedAt: 'desc' },
      take: status === 'open' ? 500 : 100,
      include: {
        job: { select: { id: true, name: true, code: true, kind: true } },
        person: { select: { id: true, name: true, email: true } },
        punches: { select: { clockIn: true, clockOut: true } },
      },
    })
    return {
      data: items.map(({ punches, ...i }) => ({ ...i, hours: punches.reduce((s, p) => s + hoursBetween(p.clockIn, p.clockOut, now), 0), onNow: punches.some((p) => !p.clockOut) })),
    }
  },
)
