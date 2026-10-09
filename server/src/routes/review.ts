import { Router, type Request } from 'express'
import type { Company } from '@prisma/client'
import { prisma } from '../db.js'
import { route, str } from '../api.js'
import { badRequest, forbidden } from '../errors.js'
import { requireAuth, requirePerson, requireScope } from '../auth/middleware.js'
import { COMPANY_MANAGE, SELF } from '../auth/apiKeys.js'
import { addDays, isYmd, localDate, weekOf } from '../lib/time.js'
import { approveWeek, DAY_NAMES, personWeek, reopenWeek, signWeek, weekSummary } from '../services/approvals.js'
import { findExceptions } from '../services/exceptions.js'
import { reconcile, replaceExternalHours } from '../services/reconcile.js'

// Review: weekly sign-off and approval, the exceptions list, the parallel-run
// reconcile, and the company settings they depend on.

export const reviewRouter = Router()

const companyOf = (companyId: string) => prisma.company.findUniqueOrThrow({ where: { id: companyId } })

const thisWeek = (c: Company) => weekOf(localDate(new Date(), c.timezone), c.weekStartDay)

/** ?week=, or any date inside the week, or the default. */
function weekParam(req: Request, c: Company, fallback: string): string {
  const raw = str(req.query.week ?? (req.body as Record<string, unknown> | undefined)?.week, 20)
  if (!raw) return fallback
  if (!isYmd(raw)) throw badRequest('week must be a date, YYYY-MM-DD.', { field: 'week' })
  return weekOf(raw, c.weekStartDay)
}

// ─── Weekly sign-off ───────────────────────────────────────────────────────

route(
  reviewRouter,
  {
    method: 'get',
    path: '/me/week',
    tag: 'Review',
    summary: 'Your own week, day by day, with whether it is signed and approved.',
    access: [SELF],
    query: { week: 'Any date in the week. Defaults to this week' },
  },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const c = await companyOf(auth.companyId)
    return personWeek(auth.companyId, person.id, weekParam(req, c, thisWeek(c)))
  },
)

route(
  reviewRouter,
  {
    method: 'post',
    path: '/approvals/sign',
    tag: 'Review',
    summary: 'Sign your own week: "these hours are right". A later change to the week clears the signature.',
    access: [SELF],
    body: { week: 'Any date in the week. Defaults to this week' },
  },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const c = await companyOf(auth.companyId)
    const approval = await signWeek(person, weekParam(req, c, thisWeek(c)))
    return { approval }
  },
)

route(
  reviewRouter,
  {
    method: 'get',
    path: '/approvals',
    tag: 'Review',
    summary: "Everyone's week: hours, signed, approved, and how many things to look at.",
    access: ['time:approve', 'reports:read'],
    query: { week: 'Any date in the week. Defaults to last week' },
  },
  async (req) => {
    const auth = requireScope(req, 'time:approve', 'reports:read')
    const c = await companyOf(auth.companyId)
    return weekSummary(auth.companyId, weekParam(req, c, addDays(thisWeek(c), -7)))
  },
)

route(
  reviewRouter,
  {
    method: 'get',
    path: '/approvals/:personId',
    tag: 'Review',
    summary: "One person's week, day by day, with every segment, its history, and the things to look at.",
    access: ['time:approve', 'reports:read', SELF],
    query: { week: 'Any date in the week. Defaults to last week' },
  },
  async (req) => {
    const auth = requireScope(req, 'time:approve', 'reports:read', SELF)
    if (!auth.scopes.has('time:approve') && !auth.scopes.has('reports:read') && auth.person?.id !== req.params.personId) {
      throw forbidden('You can only see your own week.')
    }
    const c = await companyOf(auth.companyId)
    return personWeek(auth.companyId, req.params.personId, weekParam(req, c, addDays(thisWeek(c), -7)))
  },
)

route(
  reviewRouter,
  {
    method: 'post',
    path: '/approvals/approve',
    tag: 'Review',
    summary: 'Approve a finished week for one or more people. Approved time is frozen until reopened.',
    access: ['time:approve'],
    body: { week: 'Any date in the week', personIds: 'Array of person ids', note: 'Optional note' },
  },
  async (req) => {
    const auth = requireScope(req, 'time:approve')
    const c = await companyOf(auth.companyId)
    const b = (req.body ?? {}) as Record<string, unknown>
    if (!b.week) throw badRequest('week is required.', { field: 'week' })
    const ids = Array.isArray(b.personIds) ? b.personIds.map((v) => str(v, 80)).filter(Boolean) : []
    const result = await approveWeek(auth.companyId, auth.person?.id ?? null, ids, weekParam(req, c, ''), str(b.note, 500))
    return { ...result, approved: result.results.filter((r) => r.ok).length, failed: result.results.filter((r) => !r.ok).length }
  },
)

route(
  reviewRouter,
  {
    method: 'post',
    path: '/approvals/reopen',
    tag: 'Review',
    summary: 'Undo an approval so the week can be corrected. Reason required.',
    access: ['time:approve'],
    body: { week: 'Any date in the week', personId: 'Whose week', reason: 'Why (required)' },
  },
  async (req) => {
    const auth = requireScope(req, 'time:approve')
    const c = await companyOf(auth.companyId)
    const b = (req.body ?? {}) as Record<string, unknown>
    if (!b.week) throw badRequest('week is required.', { field: 'week' })
    const approval = await reopenWeek(auth.companyId, auth.person?.id ?? null, str(b.personId, 80), weekParam(req, c, ''), str(b.reason, 500))
    return { approval }
  },
)

// ─── Exceptions ─────────────────────────────────────────────────────────────

route(
  reviewRouter,
  {
    method: 'get',
    path: '/reports/exceptions',
    tag: 'Review',
    summary: 'Things to look at: forgotten clock-outs, long days, off-site punches, scheduled days with no time, edits.',
    access: ['time:approve', 'reports:read'],
    query: {
      from: 'YYYY-MM-DD. Defaults to the start of last week',
      to: 'YYYY-MM-DD, inclusive. Defaults to today',
      personId: 'Only this person',
      severity: 'warn to leave out the informational items',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'time:approve', 'reports:read')
    const c = await companyOf(auth.companyId)
    const today = localDate(new Date(), c.timezone)
    const from = str(req.query.from, 10) || addDays(thisWeek(c), -7)
    const to = str(req.query.to, 10) || today
    if (!isYmd(from) || !isYmd(to)) throw badRequest('from and to are dates, YYYY-MM-DD.')
    if (addDays(from, 92) < to) throw badRequest('92 days at most per request.')
    let data = await findExceptions(c, { from, to, personId: str(req.query.personId, 80) || undefined })
    if (req.query.severity === 'warn') data = data.filter((e) => e.severity === 'warn')
    return { from, to, data }
  },
)

// ─── Parallel run: compare with Timesheets.com ─────────────────────────────

route(
  reviewRouter,
  {
    method: 'put',
    path: '/external-hours/:system',
    tag: 'Review',
    summary: "Replace another system's hours per person per day for a date range. GED pushes Timesheets.com hours here during the parallel run.",
    access: ['reconcile:write'],
    body: {
      from: 'YYYY-MM-DD, first day covered',
      to: 'YYYY-MM-DD, last day covered (inclusive). Days in the range that are not sent are cleared',
      rows: 'Array of { email, date (YYYY-MM-DD), hours }',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'reconcile:write')
    const b = (req.body ?? {}) as Record<string, unknown>
    return replaceExternalHours(auth.companyId, str(req.params.system, 40).toLowerCase(), str(b.from, 10), str(b.to, 10), b.rows)
  },
)

route(
  reviewRouter,
  {
    method: 'get',
    path: '/reports/reconcile',
    tag: 'Review',
    summary: 'Our hours against another system (Timesheets.com) per person per day, with the differences.',
    access: ['reports:read'],
    query: {
      from: 'YYYY-MM-DD. Defaults to the start of last week',
      to: 'YYYY-MM-DD, inclusive. Defaults to yesterday',
      system: 'Defaults to timesheets',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'reports:read')
    const c = await companyOf(auth.companyId)
    const today = localDate(new Date(), c.timezone)
    const from = str(req.query.from, 10) || addDays(thisWeek(c), -7)
    const to = str(req.query.to, 10) || addDays(today, -1)
    return reconcile(c, str(req.query.system, 40).toLowerCase() || 'timesheets', from, to)
  },
)

// ─── Company settings ───────────────────────────────────────────────────────

const companyView = (c: Company) => ({
  id: c.id,
  name: c.name,
  timezone: c.timezone,
  weekStartDay: c.weekStartDay,
  weekStartName: DAY_NAMES[c.weekStartDay],
  shopLat: c.shopLat,
  shopLng: c.shopLng,
  shopRadiusM: c.shopRadiusM,
})

route(
  reviewRouter,
  { method: 'get', path: '/company', tag: 'Company', summary: 'Company settings: timezone, week start, shop location.', access: [] },
  async (req) => {
    const auth = requireAuth(req)
    return { company: companyView(await companyOf(auth.companyId)) }
  },
)

const validTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

route(
  reviewRouter,
  {
    method: 'patch',
    path: '/company',
    tag: 'Company',
    summary: 'Change company settings. Changing the week start does not move weeks already approved.',
    access: [COMPANY_MANAGE],
    body: {
      name: 'Company name',
      timezone: 'IANA timezone, e.g. America/Los_Angeles',
      weekStartDay: '0 = Sunday … 6 = Saturday',
      shopLat: 'Shop latitude',
      shopLng: 'Shop longitude',
      shopRadiusM: 'How far from the shop pin still counts as at the shop, in metres',
    },
  },
  async (req) => {
    const auth = requireScope(req, COMPANY_MANAGE)
    const b = (req.body ?? {}) as Record<string, unknown>
    const data: Record<string, unknown> = {}
    if (b.name !== undefined) {
      const name = str(b.name, 200)
      if (!name) throw badRequest('name cannot be empty.', { field: 'name' })
      data.name = name
    }
    if (b.timezone !== undefined) {
      const tz = str(b.timezone, 60)
      if (!validTz(tz)) throw badRequest(`Unknown timezone "${tz}".`, { field: 'timezone' })
      data.timezone = tz
    }
    if (b.weekStartDay !== undefined) {
      const d = Number(b.weekStartDay)
      if (!Number.isInteger(d) || d < 0 || d > 6) throw badRequest('weekStartDay is 0 (Sunday) to 6 (Saturday).', { field: 'weekStartDay' })
      data.weekStartDay = d
    }
    for (const [field, lim] of [
      ['shopLat', 90],
      ['shopLng', 180],
    ] as const) {
      if (b[field] === undefined) continue
      if (b[field] === null || b[field] === '') {
        data[field] = null
        continue
      }
      const n = Number(b[field])
      if (!Number.isFinite(n) || Math.abs(n) > lim) throw badRequest(`${field} is not a valid coordinate.`, { field })
      data[field] = n
    }
    if (b.shopRadiusM !== undefined) {
      const r = Number(b.shopRadiusM)
      if (!Number.isFinite(r) || r < 10 || r > 10_000) throw badRequest('shopRadiusM is 10 to 10000 metres.', { field: 'shopRadiusM' })
      data.shopRadiusM = Math.round(r)
    }
    const company = await prisma.company.update({ where: { id: auth.companyId }, data })
    return { company: companyView(company) }
  },
)
