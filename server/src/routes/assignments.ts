import { Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { requiredStr, route, str } from '../api.js'
import { badRequest } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { isYmd } from '../lib/time.js'

// The day's schedule, pushed in by another app (GED reads the shared job calendar).
// Used only to pre-select the job when a tech clocks in; it never creates time.

export const assignmentsRouter = Router()

interface Incoming {
  email: string
  jobId?: string
  jobRef?: { system: string; externalId: string }
  title: string
  shopTime: string
  externalId: string
}

const MAX_ROWS = 2000

route(
  assignmentsRouter,
  {
    method: 'put',
    path: '/assignments/:date',
    tag: 'Schedule',
    summary: "Replace one day's schedule from one source. Safe to repeat; send the whole day each time.",
    access: ['assignments:write'],
    body: {
      source: 'Which system this comes from, e.g. "ged". Only rows from the same source are replaced',
      assignments:
        'Array of { email, jobRef: { system, externalId } or jobId, title, shopTime, externalId }. Unknown people are skipped and listed in the reply',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'assignments:write')
    const date = requiredStr(req.params.date, 'date', 10)
    if (!isYmd(date)) throw badRequest('date must be YYYY-MM-DD.', { field: 'date' })
    const source = (str(req.body?.source, 40) || 'api').toLowerCase()
    const raw: unknown[] = Array.isArray(req.body?.assignments) ? req.body.assignments : []
    if (raw.length > MAX_ROWS) throw badRequest(`At most ${MAX_ROWS} assignments per day.`)

    const rows: Incoming[] = raw.map((r) => {
      const o = (r ?? {}) as Record<string, unknown>
      const ref = o.jobRef as Record<string, unknown> | undefined
      return {
        email: str(o.email, 320).toLowerCase(),
        jobId: str(o.jobId, 80) || undefined,
        jobRef: ref && typeof ref === 'object' ? { system: str(ref.system, 40).toLowerCase(), externalId: str(ref.externalId, 200) } : undefined,
        title: str(o.title, 300),
        shopTime: str(o.shopTime, 20),
        externalId: str(o.externalId, 200),
      }
    })

    const emails = [...new Set(rows.map((r) => r.email).filter(Boolean))]
    const people = await prisma.person.findMany({ where: { companyId: auth.companyId, email: { in: emails } } })
    const personByEmail = new Map(people.map((p) => [p.email, p]))

    const refKeys = rows.filter((r) => r.jobRef?.system && r.jobRef.externalId)
    const refs = refKeys.length
      ? await prisma.externalRef.findMany({
          where: {
            companyId: auth.companyId,
            entity: 'job',
            OR: refKeys.map((r) => ({ system: r.jobRef!.system, externalId: r.jobRef!.externalId })),
          },
        })
      : []
    const jobByRef = new Map(refs.map((r) => [`${r.system}|${r.externalId}`, r.entityId]))
    const directIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => Boolean(x)))]
    const directJobs = directIds.length
      ? new Set((await prisma.job.findMany({ where: { companyId: auth.companyId, id: { in: directIds } }, select: { id: true } })).map((j) => j.id))
      : new Set<string>()

    const skipped: { email: string; reason: string }[] = []
    const data: Prisma.AssignmentCreateManyInput[] = []
    for (const r of rows) {
      const person = personByEmail.get(r.email)
      if (!person) {
        skipped.push({ email: r.email, reason: r.email ? 'No person with this email.' : 'No email given.' })
        continue
      }
      const jobId = (r.jobId && directJobs.has(r.jobId) ? r.jobId : null) ?? (r.jobRef ? jobByRef.get(`${r.jobRef.system}|${r.jobRef.externalId}`) ?? null : null)
      data.push({ companyId: auth.companyId, date, personId: person.id, jobId, title: r.title, shopTime: r.shopTime, source, externalId: r.externalId })
    }

    await prisma.$transaction(async (tx) => {
      await tx.assignment.deleteMany({ where: { companyId: auth.companyId, date, source } })
      if (data.length) await tx.assignment.createMany({ data })
    })
    return { date, source, saved: data.length, withJob: data.filter((d) => d.jobId).length, skipped }
  },
)

route(
  assignmentsRouter,
  { method: 'get', path: '/assignments/:date', tag: 'Schedule', summary: "One day's schedule for everyone.", access: ['punch:read'] },
  async (req) => {
    const auth = requireScope(req, 'punch:read')
    const date = requiredStr(req.params.date, 'date', 10)
    if (!isYmd(date)) throw badRequest('date must be YYYY-MM-DD.', { field: 'date' })
    const rows = await prisma.assignment.findMany({
      where: { companyId: auth.companyId, date },
      include: { job: true, person: { select: { id: true, name: true, email: true } } },
      orderBy: [{ shopTime: 'asc' }, { createdAt: 'asc' }],
    })
    return { date, data: rows }
  },
)
