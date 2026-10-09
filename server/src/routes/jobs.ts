import { Router } from 'express'
import type { Job, Prisma } from '@prisma/client'
import { prisma, type Tx } from '../db.js'
import { bool, limitOf, optionalDate, requiredStr, route, str } from '../api.js'
import { badRequest, notFound } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { emit } from '../services/events.js'

export const jobsRouter = Router()

const KINDS = ['project', 'service', 'shop', 'other']

const num = (v: unknown, field: string): number | null | undefined => {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`, { field })
  return n
}

function jobFields(body: Record<string, unknown> | undefined) {
  const kind = body?.kind === undefined ? undefined : String(body.kind)
  if (kind !== undefined && !KINDS.includes(kind)) throw badRequest('kind must be project, service, shop or other.', { field: 'kind' })
  const radius = num(body?.siteRadiusM, 'siteRadiusM')
  return {
    kind,
    name: body?.name === undefined ? undefined : requiredStr(body.name, 'name', 300),
    code: body?.code === undefined ? undefined : str(body.code, 80),
    active: bool(body?.active),
    siteLat: num(body?.siteLat, 'siteLat'),
    siteLng: num(body?.siteLng, 'siteLng'),
    siteRadiusM: radius === null || radius === undefined ? radius : Math.round(radius),
  }
}

async function withRefs(jobs: Job[]) {
  if (!jobs.length) return []
  const refs = await prisma.externalRef.findMany({ where: { entity: 'job', entityId: { in: jobs.map((j) => j.id) } } })
  return jobs.map((j) => ({
    ...j,
    refs: refs.filter((r) => r.entityId === j.id).map((r) => ({ system: r.system, externalId: r.externalId })),
  }))
}

const announce = (tx: Tx, job: Job) =>
  emit(tx, job.companyId, 'job.upserted', { job: { id: job.id, kind: job.kind, name: job.name, code: job.code, active: job.active } })

route(
  jobsRouter,
  {
    method: 'get',
    path: '/jobs',
    tag: 'Jobs',
    summary: 'Jobs time can be charged to.',
    access: ['jobs:read'],
    query: {
      active: 'true (default) or false; "all" for both',
      kind: 'project | service | shop | other',
      q: 'Search name and code',
      updatedSince: 'ISO date-time; only jobs changed after it',
      limit: 'Page size, 100 by default, 500 at most',
      cursor: 'nextCursor from the previous page',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:read')
    const q = str(req.query.q, 100)
    const where: Prisma.JobWhereInput = {
      companyId: auth.companyId,
      active: req.query.active === 'all' ? undefined : bool(req.query.active) ?? true,
      kind: req.query.kind ? String(req.query.kind) : undefined,
      updatedAt: req.query.updatedSince ? { gt: optionalDate(req.query.updatedSince, 'updatedSince') } : undefined,
      OR: q ? [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }] : undefined,
    }
    const limit = limitOf(req.query.limit)
    const cursor = str(req.query.cursor, 80)
    const rows = await prisma.job.findMany({
      where,
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, limit)
    return { data: await withRefs(page), nextCursor: rows.length > limit ? page[page.length - 1].id : null }
  },
)

route(
  jobsRouter,
  {
    method: 'post',
    path: '/jobs',
    tag: 'Jobs',
    summary: 'Add a job by hand.',
    access: ['jobs:write'],
    status: 201,
    body: { name: 'Name', kind: 'project | service | shop | other', code: 'P-number or ticket', siteLat: 'Site latitude', siteLng: 'Site longitude', siteRadiusM: 'Site radius in metres' },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const f = jobFields(req.body)
    if (!f.name) throw badRequest('name is required.', { field: 'name' })
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.job.create({
        data: { companyId: auth.companyId, name: f.name!, kind: f.kind ?? 'project', code: f.code ?? '', active: f.active ?? true, siteLat: f.siteLat, siteLng: f.siteLng, siteRadiusM: f.siteRadiusM },
      })
      await announce(tx, created)
      return created
    })
    return { job: (await withRefs([job]))[0] }
  },
)

route(
  jobsRouter,
  { method: 'patch', path: '/jobs/:id', tag: 'Jobs', summary: 'Change a job. Set active to false to close it to new time.', access: ['jobs:write'], body: { name: 'Name', kind: 'Kind', code: 'Code', active: 'true or false', siteLat: 'Job site latitude, or null', siteLng: 'Job site longitude, or null', siteRadiusM: 'How far from the pin still counts as on site, in metres (200 if not set)' } },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const existing = await prisma.job.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!existing) throw notFound('Job')
    const f = jobFields(req.body)
    const job = await prisma.$transaction(async (tx) => {
      const saved = await tx.job.update({ where: { id: existing.id }, data: f })
      await announce(tx, saved)
      return saved
    })
    return { job: (await withRefs([job]))[0] }
  },
)

route(
  jobsRouter,
  {
    method: 'put',
    path: '/jobs/by-ref/:system/:externalId',
    tag: 'Jobs',
    summary: 'Create or update a job by its id in another system (ged, jetbuilt, timesheets…). Safe to repeat.',
    access: ['jobs:write'],
    body: { name: 'Name (required when creating)', kind: 'project | service | shop | other', code: 'P-number or ticket', active: 'false closes the job to new time' },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const system = requiredStr(req.params.system, 'system', 40).toLowerCase()
    const externalId = requiredStr(req.params.externalId, 'externalId', 200)
    const f = jobFields(req.body)

    const result = await prisma.$transaction(async (tx) => {
      const key = { companyId_entity_system_externalId: { companyId: auth.companyId, entity: 'job', system, externalId } }
      const ref = await tx.externalRef.findUnique({ where: key })
      if (ref) {
        const saved = await tx.job.update({ where: { id: ref.entityId }, data: f })
        await announce(tx, saved)
        return { created: false, job: saved }
      }
      if (!f.name) throw badRequest('name is required when the job does not exist yet.', { field: 'name' })
      const created = await tx.job.create({
        data: { companyId: auth.companyId, name: f.name, kind: f.kind ?? 'project', code: f.code ?? '', active: f.active ?? true, siteLat: f.siteLat, siteLng: f.siteLng, siteRadiusM: f.siteRadiusM },
      })
      await tx.externalRef.create({ data: { companyId: auth.companyId, entity: 'job', entityId: created.id, system, externalId } })
      await announce(tx, created)
      return { created: true, job: created }
    })
    return { created: result.created, job: (await withRefs([result.job]))[0] }
  },
)

route(
  jobsRouter,
  { method: 'get', path: '/phases', tag: 'Jobs', summary: 'The phases of the work day, in order.', access: ['jobs:read'] },
  async (req) => {
    const auth = requireScope(req, 'jobs:read')
    return { data: await prisma.phase.findMany({ where: { companyId: auth.companyId, active: true }, orderBy: { sortOrder: 'asc' } }) }
  },
)
