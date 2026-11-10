import type { Person, Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { badRequest, conflict } from '../errors.js'
import { emit } from './events.js'

// Times people fixed themselves (services/punch.ts editOwnTimes). They count at once,
// with no approval first; a supervisor or admin looks them over afterwards and marks
// them looked at. Until then they show as edited on Review.

export type ReviewStatus = 'waiting' | 'reviewed' | 'all'

interface Times {
  clockIn: string
  clockOut: string | null
}

const timesOf = (j: Prisma.JsonValue): Times | null => {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null
  const o = j as Record<string, unknown>
  return typeof o.clockIn === 'string' ? { clockIn: o.clockIn, clockOut: typeof o.clockOut === 'string' ? o.clockOut : null } : null
}

export async function listSelfEdits(companyId: string, opts: { status?: ReviewStatus; personId?: string; from?: Date; to?: Date; limit?: number }) {
  const status = opts.status ?? 'waiting'
  const rows = await prisma.punchEdit.findMany({
    where: {
      selfEdit: true,
      reviewedAt: status === 'waiting' ? null : status === 'reviewed' ? { not: null } : undefined,
      punch: {
        companyId,
        personId: opts.personId || undefined,
        clockIn: opts.from || opts.to ? { gte: opts.from, lt: opts.to } : undefined,
      },
    },
    orderBy: { at: status === 'waiting' ? 'asc' : 'desc' },
    take: Math.min(opts.limit ?? 200, 500),
    include: {
      punch: {
        select: {
          id: true,
          personId: true,
          clockIn: true,
          clockOut: true,
          person: { select: { id: true, name: true } },
          job: { select: { id: true, name: true, code: true } },
          phase: { select: { id: true, name: true, short: true } },
        },
      },
    },
  })
  const reviewerIds = [...new Set(rows.map((r) => r.reviewedById).filter((x): x is string => Boolean(x)))]
  const reviewers = new Map((await prisma.person.findMany({ where: { id: { in: reviewerIds } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]))
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    reason: r.reason,
    person: r.punch.person,
    segment: {
      id: r.punch.id,
      clockIn: r.punch.clockIn,
      clockOut: r.punch.clockOut,
      job: r.punch.job,
      phase: r.punch.phase,
    },
    before: timesOf(r.before),
    after: timesOf(r.after),
    reviewedBy: r.reviewedById ? reviewers.get(r.reviewedById) ?? '' : null,
    reviewedAt: r.reviewedAt,
  }))
}

/** How many self-fixes are waiting to be looked at, per person, for segments in [from, to). */
export async function waitingByPerson(companyId: string, from: Date, to: Date): Promise<Map<string, number>> {
  const rows = await prisma.punchEdit.findMany({
    where: { selfEdit: true, reviewedAt: null, punch: { companyId, clockIn: { gte: from, lt: to } } },
    select: { punch: { select: { personId: true } } },
  })
  const out = new Map<string, number>()
  for (const r of rows) out.set(r.punch.personId, (out.get(r.punch.personId) ?? 0) + 1)
  return out
}

/**
 * A supervisor or admin marks self-fixes as looked at. Someone else looks over a
 * change to your own time, unless you are an admin (the same rule as change requests).
 */
export async function markReviewed(reviewer: Person, ids: string[]) {
  const want = [...new Set(ids)].filter(Boolean)
  if (!want.length) throw badRequest('ids must list at least one edit.', { field: 'ids' })
  if (want.length > 500) throw badRequest('Mark 500 edits at most per call.', { field: 'ids' })
  const rows = await prisma.punchEdit.findMany({
    where: { id: { in: want }, selfEdit: true, punch: { companyId: reviewer.companyId } },
    select: { id: true, reviewedAt: true, editedById: true, punch: { select: { personId: true } } },
  })
  if (reviewer.role !== 'admin' && rows.some((r) => r.punch.personId === reviewer.id)) {
    throw conflict('own_time', 'Someone else has to look over changes to your own time.')
  }
  const toMark = rows.filter((r) => !r.reviewedAt).map((r) => r.id)
  if (toMark.length) {
    await prisma.$transaction(async (tx) => {
      await tx.punchEdit.updateMany({ where: { id: { in: toMark }, reviewedAt: null }, data: { reviewedAt: new Date(), reviewedById: reviewer.id } })
      await emit(tx, reviewer.companyId, 'punch.edits_reviewed', { ids: toMark, by: reviewer.id })
    })
  }
  return { marked: toMark.length, alreadyDone: rows.length - toMark.length, notFound: want.length - rows.length }
}
