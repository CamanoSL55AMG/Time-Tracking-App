import { Router } from 'express'
import type { Job, Prisma } from '@prisma/client'
import { prisma, type Tx } from '../db.js'
import { bool, limitOf, optionalDate, requiredStr, route, str } from '../api.js'
import { badRequest, notFound } from '../errors.js'
import { requirePerson, requireScope } from '../auth/middleware.js'
import { SELF } from '../auth/apiKeys.js'
import { emit } from '../services/events.js'
import { MODES } from '../services/punch.js'
import { isArchived } from '../services/jobArchive.js'

export const jobsRouter = Router()

// repair = an Electronic Repair (SD) ticket from AV Inventory's Service Dept. check-in.
// visit = a pre-sale site visit: paid time, never billed to the client.
const KINDS = ['project', 'service', 'visit', 'shop', 'repair', 'other']
/** What a tech can add from the punch screen. */
const FIELD_KINDS = ['service', 'visit']

const num = (v: unknown, field: string): number | null | undefined => {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const n = Number(v)
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`, { field })
  return n
}

function jobFields(body: Record<string, unknown> | undefined) {
  const kind = body?.kind === undefined ? undefined : String(body.kind)
  if (kind !== undefined && !KINDS.includes(kind)) throw badRequest('kind must be project, service, visit, shop, repair or other.', { field: 'kind' })
  const radius = num(body?.siteRadiusM, 'siteRadiusM')
  return {
    kind,
    name: body?.name === undefined ? undefined : requiredStr(body.name, 'name', 300),
    code: body?.code === undefined ? undefined : str(body.code, 80),
    active: bool(body?.active),
    stage: body?.stage === undefined ? undefined : str(body.stage, 40).toUpperCase(),
    siteLat: num(body?.siteLat, 'siteLat'),
    siteLng: num(body?.siteLng, 'siteLng'),
    siteRadiusM: radius === null || radius === undefined ? radius : Math.round(radius),
    siteAddress: body?.siteAddress === undefined ? undefined : str(body.siteAddress, 300),
    clientName: body?.clientName === undefined ? undefined : str(body.clientName, 200),
    contactName: body?.contactName === undefined ? undefined : str(body.contactName, 200),
    contactPhone: body?.contactPhone === undefined ? undefined : phoneOf(body.contactPhone, false),
    contactEmail: body?.contactEmail === undefined ? undefined : emailOf(body.contactEmail, false),
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
function emailOf(v: unknown, required: boolean): string {
  const s = str(v, 200)
  if (!s) {
    if (required) throw badRequest('contactEmail is required.', { field: 'contactEmail' })
    return ''
  }
  if (!EMAIL.test(s)) throw badRequest('contactEmail does not look like an email address.', { field: 'contactEmail' })
  return s.toLowerCase()
}
function phoneOf(v: unknown, required: boolean): string {
  const s = str(v, 40)
  if (!s) {
    if (required) throw badRequest('contactPhone is required.', { field: 'contactPhone' })
    return ''
  }
  const digits = s.replace(/\D/g, '')
  if (digits.length < 10) throw badRequest('contactPhone needs at least 10 digits, with the area code.', { field: 'contactPhone' })
  return s
}

const ADDED_BY = { addedBy: { select: { id: true, name: true } } } as const

// Each job also carries when time was last charged to it and whether it folds
// under Archived in the lists (services/jobArchive.ts). Nothing is stored for that.
async function withRefs(jobs: Job[]) {
  if (!jobs.length) return []
  const ids = jobs.map((j) => j.id)
  const [refs, last] = await Promise.all([
    prisma.externalRef.findMany({ where: { entity: 'job', entityId: { in: ids } } }),
    prisma.punch.groupBy({ by: ['jobId'], where: { jobId: { in: ids } }, _max: { clockIn: true } }),
  ])
  const lastBy = new Map(last.map((l) => [l.jobId, l._max.clockIn]))
  const now = new Date()
  return jobs.map((j) => {
    const lastPunchAt = lastBy.get(j.id) ?? null
    return {
      ...j,
      refs: refs.filter((r) => r.entityId === j.id).map((r) => ({ system: r.system, externalId: r.externalId })),
      lastPunchAt,
      archived: isArchived({ ...j, lastPunchAt }, now),
    }
  })
}

const announce = (tx: Tx, job: Job) =>
  emit(tx, job.companyId, 'job.upserted', { job: { id: job.id, kind: job.kind, name: job.name, code: job.code, active: job.active } })

route(
  jobsRouter,
  {
    method: 'get',
    path: '/jobs',
    tag: 'Jobs',
    summary: 'Jobs time can be charged to. Each carries lastPunchAt and archived (an old project, or one closed to new time).',
    access: ['jobs:read'],
    // The company's job list, which every tech reads to clock in. Nobody's time in it.
    division: 'scoped',
    query: {
      active: 'true (default) or false; "all" for both',
      kind: 'project | service | shop | other',
      q: 'Search name and code',
      added: '"review" for clients techs added that the office has not checked yet; "all" for every tech-added client',
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
      OR: q
        ? [{ name: { contains: q, mode: 'insensitive' } }, { code: { contains: q, mode: 'insensitive' } }, { clientName: { contains: q, mode: 'insensitive' } }]
        : undefined,
      ...(req.query.added === 'review' ? { addedById: { not: null }, reviewedAt: null } : req.query.added === 'all' ? { addedById: { not: null } } : {}),
    }
    const limit = limitOf(req.query.limit)
    const cursor = str(req.query.cursor, 80)
    const rows = await prisma.job.findMany({
      where,
      include: ADDED_BY,
      orderBy: req.query.added ? [{ createdAt: 'desc' }, { id: 'asc' }] : [{ name: 'asc' }, { id: 'asc' }],
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
    body: { name: 'Name', kind: 'project | service | shop | other', code: 'P-number or ticket', siteLat: 'Site latitude', siteLng: 'Site longitude', siteRadiusM: 'Site radius in metres', siteAddress: 'Street address, for directions' },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const f = jobFields(req.body)
    if (!f.name) throw badRequest('name is required.', { field: 'name' })
    const job = await prisma.$transaction(async (tx) => {
      const created = await tx.job.create({
        data: {
          companyId: auth.companyId,
          name: f.name!,
          kind: f.kind ?? 'project',
          code: f.code ?? '',
          active: f.active ?? true,
          siteLat: f.siteLat,
          siteLng: f.siteLng,
          siteRadiusM: f.siteRadiusM,
          siteAddress: f.siteAddress ?? '',
          clientName: f.clientName ?? '',
          contactName: f.contactName ?? '',
          contactPhone: f.contactPhone ?? '',
          contactEmail: f.contactEmail ?? '',
        },
      })
      await announce(tx, created)
      return created
    })
    return { job: (await withRefs([job]))[0] }
  },
)

// ─── A tech adds a client from the field ─────────────────────────────────────
// Any tech can add a Service Call or a Site Visit for a client that is not in the
// list yet (Art, 2026-11-02), then switch onto it. Name, address, a contact person,
// phone and email are the minimum. The office sees it under Manage > Jobs, "Added
// by techs", until someone marks it checked.
route(
  jobsRouter,
  {
    method: 'post',
    path: '/me/jobs',
    tag: 'Jobs',
    summary: 'Add a Service Call or Site Visit for a new client, from the punch screen. Re-sending the same client and address returns the one already added.',
    access: [SELF],
    status: 201,
    body: {
      kind: 'service (Service Call) | visit (Site Visit, pre-sale, not billed)',
      clientName: 'Client name (required)',
      siteAddress: 'Street address (required)',
      contactName: 'Contact person (required)',
      contactPhone: 'Contact phone, with area code (required)',
      contactEmail: 'Contact email (required)',
      note: 'What the call is about (optional)',
    },
  },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const b = (req.body ?? {}) as Record<string, unknown>
    const kind = String(b.kind ?? '')
    if (!FIELD_KINDS.includes(kind)) throw badRequest('kind must be service (Service Call) or visit (Site Visit).', { field: 'kind' })
    const clientName = requiredStr(b.clientName, 'clientName', 200)
    const siteAddress = requiredStr(b.siteAddress, 'siteAddress', 300)
    const contactName = requiredStr(b.contactName, 'contactName', 200)
    const contactPhone = phoneOf(b.contactPhone, true)
    const contactEmail = emailOf(b.contactEmail, true)

    const result = await prisma.$transaction(async (tx) => {
      // The same client at the same address, still open: hand that one back
      // (a double tap, or two techs on one call) instead of a duplicate.
      const same = await tx.job.findFirst({
        where: {
          companyId: auth.companyId,
          kind,
          active: true,
          clientName: { equals: clientName, mode: 'insensitive' },
          siteAddress: { equals: siteAddress, mode: 'insensitive' },
        },
        include: ADDED_BY,
      })
      if (same) return { created: false, job: same }
      const n = await tx.job.count({ where: { companyId: auth.companyId, code: { startsWith: 'NEW-' } } })
      const created = await tx.job.create({
        data: {
          companyId: auth.companyId,
          kind,
          name: kind === 'visit' ? `Site visit — ${clientName}` : clientName,
          code: `NEW-${String(n + 1).padStart(4, '0')}`,
          clientName,
          siteAddress,
          contactName,
          contactPhone,
          contactEmail,
          addedById: person.id,
        },
        include: ADDED_BY,
      })
      await announce(tx, created)
      await emit(tx, auth.companyId, 'job.added_by_tech', {
        job: { id: created.id, kind, code: created.code, name: created.name, clientName, siteAddress, contactName, contactPhone, contactEmail },
        person: { id: person.id, name: person.name },
        note: str(b.note, 500) || undefined,
      })
      return { created: true, job: created }
    })
    return { created: result.created, job: (await withRefs([result.job]))[0] }
  },
)

route(
  jobsRouter,
  {
    method: 'patch',
    path: '/jobs/:id',
    tag: 'Jobs',
    summary: 'Change a job. Set active to false to close it to new time; reviewed true marks a tech-added client as checked by the office.',
    access: ['jobs:write'],
    body: { name: 'Name', kind: 'Kind', code: 'Code', active: 'true or false', clientName: 'Client', contactName: 'Contact', contactPhone: 'Phone', contactEmail: 'Email', reviewed: 'true or false' },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const existing = await prisma.job.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!existing) throw notFound('Job')
    const f = jobFields(req.body)
    const reviewed = bool(req.body?.reviewed)
    const data = { ...f, ...(reviewed === undefined ? {} : { reviewedAt: reviewed ? existing.reviewedAt ?? new Date() : null }) }
    const job = await prisma.$transaction(async (tx) => {
      const saved = await tx.job.update({ where: { id: existing.id }, data, include: ADDED_BY })
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
    body: {
      name: 'Name (required when creating)',
      kind: 'project | service | shop | other',
      code: 'P-number or ticket',
      active: 'false closes the job to new time',
      stage: 'Jetbuilt stage (PROPOSAL, CONTRACT, INSTALL, REVIEW…); won stages keep a project out of Archived',
    },
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
        data: { companyId: auth.companyId, name: f.name, kind: f.kind ?? 'project', code: f.code ?? '', active: f.active ?? true, stage: f.stage ?? '', siteLat: f.siteLat, siteLng: f.siteLng, siteRadiusM: f.siteRadiusM, siteAddress: f.siteAddress ?? '' },
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
  {
    method: 'get',
    path: '/phases',
    tag: 'Jobs',
    summary: 'The phases of the work day, in order.',
    access: ['jobs:read'],
    division: 'scoped',
    query: { all: 'true to include switched-off phases (needs jobs:write)' },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:read')
    const all = req.query.all === 'true' && auth.scopes.has('jobs:write')
    return {
      data: await prisma.phase.findMany({ where: { companyId: auth.companyId, ...(all ? {} : { active: true }) }, orderBy: { sortOrder: 'asc' } }),
    }
  },
)

route(
  jobsRouter,
  {
    method: 'get',
    path: '/company/bench-settings',
    tag: 'Jobs',
    summary: 'Bench Repair: clock in / clock out only, or the full version with repair tickets and tasks.',
    access: ['jobs:read'],
    division: 'scoped',
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:read')
    const c = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    return { clockOnly: c.benchClockOnly }
  },
)

route(
  jobsRouter,
  {
    method: 'patch',
    path: '/company/bench-settings',
    tag: 'Jobs',
    summary: 'Switch Bench Repair between clock in / clock out only and the full version (repair tickets, tasks, hours to the SD invoice).',
    access: ['jobs:write'],
    body: { clockOnly: 'true = clock in and clock out only; false = pick the repair ticket and task' },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const clockOnly = bool(req.body?.clockOnly)
    if (clockOnly === undefined) throw badRequest('clockOnly must be true or false.', { field: 'clockOnly' })
    const c = await prisma.company.update({ where: { id: auth.companyId }, data: { benchClockOnly: clockOnly } })
    return { clockOnly: c.benchClockOnly }
  },
)

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)

route(
  jobsRouter,
  {
    method: 'post',
    path: '/phases',
    tag: 'Jobs',
    summary: 'Add a phase. It goes to the end of the list unless sortOrder is given.',
    access: ['jobs:write'],
    status: 201,
    body: {
      name: 'Name (required)',
      short: 'Short label (defaults to the name)',
      key: 'Stable id, e.g. "site-survey" (made from the name when left out)',
      laborCategory: 'engineering | install | programming | management | service | other (default install)',
      dayFlow: 'true if "Next" steps through it during the field day (default false)',
      mode: 'Work mode it is offered in: install | service | office | shop (default office)',
      atShop: 'true if it happens at the shop',
      sortOrder: 'Position in the list (lower first)',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const b = req.body ?? {}
    const name = requiredStr(b.name, 'name', 120)
    const key = slug(str(b.key, 40) || name)
    if (!key) throw badRequest('key must contain letters or numbers.', { field: 'key' })
    const laborCategory = b.laborCategory === undefined ? 'install' : String(b.laborCategory)
    if (!LABOR_CATEGORIES.includes(laborCategory)) {
      throw badRequest(`laborCategory must be one of ${LABOR_CATEGORIES.join(', ')}.`, { field: 'laborCategory' })
    }
    if (await prisma.phase.findFirst({ where: { companyId: auth.companyId, key } })) {
      throw badRequest(`A phase with the key "${key}" already exists.`, { field: 'key' })
    }
    const sortOrder = num(b.sortOrder, 'sortOrder')
    const last = await prisma.phase.findFirst({ where: { companyId: auth.companyId }, orderBy: { sortOrder: 'desc' } })
    const phase = await prisma.phase.create({
      data: {
        companyId: auth.companyId,
        key,
        name,
        short: str(b.short, 40) || name.slice(0, 40),
        laborCategory,
        dayFlow: bool(b.dayFlow) ?? false,
        mode: modeOf(b.mode) ?? 'office',
        atShop: bool(b.atShop) ?? false,
        sortOrder: sortOrder == null ? (last?.sortOrder ?? 0) + 10 : Math.round(sortOrder),
      },
    })
    return { phase }
  },
)

const LABOR_CATEGORIES = ['engineering', 'install', 'programming', 'management', 'service', 'other']

function modeOf(v: unknown): string | undefined {
  if (v === undefined) return undefined
  const m = String(v)
  if (!(MODES as readonly string[]).includes(m)) throw badRequest(`mode must be one of ${MODES.join(', ')}.`, { field: 'mode' })
  return m
}

route(
  jobsRouter,
  {
    method: 'patch',
    path: '/phases/:id',
    tag: 'Jobs',
    summary: 'Change a phase: its name, order, the sold-labor line it rolls up to, or whether it is a step of the field day.',
    access: ['jobs:write'],
    body: {
      name: 'Name',
      short: 'Short label',
      sortOrder: 'Position in the list (lower first)',
      laborCategory: 'engineering | install | programming | management | service | other',
      dayFlow: 'true if "Next" steps through it during the field day',
      mode: 'install | service | office | shop',
      active: 'false hides it from the picker',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const existing = await prisma.phase.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!existing) throw notFound('Phase')
    const b = req.body ?? {}
    const laborCategory = b.laborCategory === undefined ? undefined : String(b.laborCategory)
    if (laborCategory !== undefined && !LABOR_CATEGORIES.includes(laborCategory)) {
      throw badRequest(`laborCategory must be one of ${LABOR_CATEGORIES.join(', ')}.`, { field: 'laborCategory' })
    }
    const sortOrder = num(b.sortOrder, 'sortOrder')
    if (sortOrder === null) throw badRequest('sortOrder cannot be empty.', { field: 'sortOrder' })
    const phase = await prisma.phase.update({
      where: { id: existing.id },
      data: {
        name: b.name === undefined ? undefined : requiredStr(b.name, 'name', 120),
        short: b.short === undefined ? undefined : requiredStr(b.short, 'short', 40),
        sortOrder: sortOrder === undefined ? undefined : Math.round(sortOrder),
        laborCategory,
        dayFlow: bool(b.dayFlow),
        mode: modeOf(b.mode),
        active: bool(b.active),
      },
    })
    return { phase }
  },
)
