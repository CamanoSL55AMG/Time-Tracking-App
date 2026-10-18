import { Router } from 'express'
import { prisma } from '../db.js'
import { optionalDate, requiredStr, route, str } from '../api.js'
import { ApiError, badRequest } from '../errors.js'
import { requireAuth, requirePerson, requireScope } from '../auth/middleware.js'
import { APPROVE, CREW, SELF } from '../auth/apiKeys.js'
import { parseGeo } from '../lib/geo.js'
import { addDays, dayBounds, isYmd, startOfLocalDay } from '../lib/time.js'
import { approveWeek, personWeek, reopenWeek, signWeek, weekSheet } from '../services/timesheets.js'
import { findExceptions } from '../services/exceptions.js'
import { createRequest, decideRequest, listRequests, withdrawRequest } from '../services/requests.js'
import { personState, punchIn, punchNext, punchOut, type Actor, type PunchInput } from '../services/punch.js'

export const timesheetsRouter = Router()

const WEEK = { week: 'Any date in the week, YYYY-MM-DD. Defaults to this week' }

/** A person's week plus the change requests made for it. */
async function weekWithRequests(companyId: string, personId: string, week: string | undefined) {
  const w = await personWeek(companyId, personId, week)
  return { ...w, requests: await listRequests(companyId, { personId, weekStart: w.weekStart }) }
}

// ─── The tech's own week ────────────────────────────────────────────────────

route(
  timesheetsRouter,
  { method: 'get', path: '/me/week', tag: 'Timesheets', summary: 'Your week: segments by day, total, and whether it is signed or approved.', access: [SELF], query: WEEK },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    return weekWithRequests(auth.companyId, person.id, str(req.query.week, 10) || undefined)
  },
)

route(
  timesheetsRouter,
  {
    method: 'post',
    path: '/me/week/sign',
    tag: 'Timesheets',
    summary: 'Sign your week: you confirm the hours are right. A later change sends it back for signing.',
    access: [SELF],
    body: WEEK,
  },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const week = str(req.body?.week, 10) || undefined
    await signWeek(person, week)
    return weekWithRequests(auth.companyId, person.id, week)
  },
)

// ─── Approvers ──────────────────────────────────────────────────────────────

route(
  timesheetsRouter,
  { method: 'get', path: '/timesheets', tag: 'Timesheets', summary: "Everyone's week: hours per day, sign-off state and problems to look at.", access: ['punch:read'], query: WEEK },
  async (req) => weekSheet(requireScope(req, 'punch:read').companyId, str(req.query.week, 10) || undefined),
)

route(
  timesheetsRouter,
  { method: 'get', path: '/timesheets/:personId', tag: 'Timesheets', summary: "One person's week in detail.", access: ['punch:read'], query: WEEK },
  async (req) => weekWithRequests(requireScope(req, 'punch:read').companyId, req.params.personId, str(req.query.week, 10) || undefined),
)

route(
  timesheetsRouter,
  {
    method: 'post',
    path: '/timesheets/approve',
    tag: 'Timesheets',
    summary: 'Approve a finished week for one or more people. Approved weeks are locked.',
    access: [APPROVE],
    body: { personIds: 'People to approve', ...WEEK, note: 'Optional note kept with the approval' },
  },
  async (req) => {
    const auth = requireScope(req, APPROVE)
    const approver = requirePerson(auth)
    const ids = Array.isArray(req.body?.personIds) ? (req.body.personIds as unknown[]).map((x) => str(x, 80)).filter(Boolean) : []
    if (!ids.length) throw badRequest('personIds must list at least one person.', { field: 'personIds' })
    if (ids.length > 200) throw badRequest('Approve 200 people at most per call.', { field: 'personIds' })
    const results = await approveWeek(auth.companyId, approver.id, ids, str(req.body?.week, 10) || undefined, str(req.body?.note, 500))
    return { results, approved: results.filter((r) => r.ok).length }
  },
)

route(
  timesheetsRouter,
  {
    method: 'post',
    path: '/timesheets/reopen',
    tag: 'Timesheets',
    summary: 'Unlock an approved or signed week so it can be corrected.',
    access: [APPROVE],
    body: { personId: 'Whose week', ...WEEK, reason: 'Why it is being reopened (required)' },
  },
  async (req) => {
    const auth = requireScope(req, APPROVE)
    const approver = requirePerson(auth)
    const personId = requiredStr(req.body?.personId, 'personId', 80)
    const week = str(req.body?.week, 10) || undefined
    await reopenWeek(auth.companyId, approver.id, personId, week, str(req.body?.reason, 500))
    return weekWithRequests(auth.companyId, personId, week)
  },
)

// ─── Change requests ────────────────────────────────────────────────────────
// A person asks for their own time to be fixed; nothing changes until a
// supervisor approves. Approving applies it as an audited correction.

route(
  timesheetsRouter,
  {
    method: 'post',
    path: '/me/requests',
    tag: 'Timesheets',
    summary: 'Ask for a change to your own time: fix a segment (send punchId) or add missing time (no punchId).',
    access: [SELF],
    status: 201,
    body: {
      punchId: 'The segment to fix. Omit to add missing time',
      clockIn: 'Requested start (ISO date-time)',
      clockOut: 'Requested end',
      jobId: 'Requested job (required for missing time)',
      phaseId: 'Requested phase',
      notes: 'Requested note',
      reason: 'What happened (required)',
    },
  },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const b = (req.body ?? {}) as Record<string, unknown>
    const created = await createRequest(person, {
      punchId: str(b.punchId, 80) || undefined,
      clockIn: optionalDate(b.clockIn, 'clockIn'),
      clockOut: optionalDate(b.clockOut, 'clockOut'),
      jobId: str(b.jobId, 80) || undefined,
      phaseId: str(b.phaseId, 80) || undefined,
      notes: b.notes === undefined ? undefined : str(b.notes, 500),
      reason: str(b.reason, 500),
    })
    return { request: (await listRequests(auth.companyId, { personId: person.id, limit: 30 })).find((r) => r.id === created.id) }
  },
)

route(
  timesheetsRouter,
  { method: 'get', path: '/me/requests', tag: 'Timesheets', summary: 'Your change requests, newest first.', access: [SELF] },
  async (req) => {
    const auth = requireScope(req, SELF)
    return { data: await listRequests(auth.companyId, { personId: requirePerson(auth).id, limit: 30 }) }
  },
)

route(
  timesheetsRouter,
  { method: 'post', path: '/me/requests/:id/withdraw', tag: 'Timesheets', summary: 'Take back a change request nobody has decided yet.', access: [SELF] },
  async (req) => {
    const auth = requireScope(req, SELF)
    return { request: await withdrawRequest(requirePerson(auth), req.params.id) }
  },
)

route(
  timesheetsRouter,
  {
    method: 'get',
    path: '/requests',
    tag: 'Timesheets',
    summary: 'Change requests to decide (status=pending), or the history.',
    access: ['punch:read'],
    query: { status: 'pending, approved, rejected or withdrawn. Defaults to all', personId: 'Only this person' },
  },
  async (req) => {
    const auth = requireScope(req, 'punch:read')
    const status = str(req.query.status, 20)
    if (status && !['pending', 'approved', 'rejected', 'withdrawn'].includes(status)) throw badRequest('status must be pending, approved, rejected or withdrawn.', { field: 'status' })
    return { data: await listRequests(auth.companyId, { status: status || undefined, personId: str(req.query.personId, 80) || undefined }) }
  },
)

for (const decision of ['approve', 'reject'] as const) {
  route(
    timesheetsRouter,
    {
      method: 'post',
      path: `/requests/:id/${decision}`,
      tag: 'Timesheets',
      summary: decision === 'approve' ? 'Approve a change request; the change is applied as a correction.' : 'Turn down a change request.',
      access: [APPROVE],
      body: { note: decision === 'approve' ? 'Optional note' : 'Why it is turned down (required)' },
    },
    async (req) => {
      const auth = requireScope(req, APPROVE)
      return { request: await decideRequest(requirePerson(auth), req.params.id, decision, str(req.body?.note, 500)) }
    },
  )
}

route(
  timesheetsRouter,
  {
    method: 'get',
    path: '/reports/exceptions',
    tag: 'Views',
    summary: 'Punches to look at: missed clock-outs, long days, punches away from the site, corrections, punches sent late.',
    access: ['reports:read', 'punch:read'],
    query: { from: 'YYYY-MM-DD, defaults to 7 days ago', to: 'YYYY-MM-DD inclusive, defaults to today', personId: 'Only this person' },
  },
  async (req) => {
    const auth = requireScope(req, 'reports:read', 'punch:read')
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const today = dayBounds(new Date(), company.timezone).date
    const fromRaw = str(req.query.from, 10) || addDays(today, -6)
    const toRaw = str(req.query.to, 10) || today
    if (!isYmd(fromRaw) || !isYmd(toRaw)) throw badRequest('from and to must be dates, YYYY-MM-DD.')
    const from = startOfLocalDay(fromRaw, company.timezone)
    const to = startOfLocalDay(addDays(toRaw, 1), company.timezone)
    if (to <= from) throw badRequest('to must not be before from.')
    return { from: fromRaw, to: toRaw, data: await findExceptions(auth.companyId, { from, to, personId: str(req.query.personId, 80) || undefined }) }
  },
)

// ─── Crew punch ─────────────────────────────────────────────────────────────
// A lead punches the crew together. Each person is punched on their own, so one
// refusal (already on that job, a locked week) does not stop the rest.

const CREW_BODY = {
  personIds: 'Crew members to punch (30 at most). Include yourself only if you are not punching yourself separately',
  jobId: 'Job (in only)',
  phaseId: 'Phase. For next, omit to move each person to their own next phase',
  phaseKey: 'Alternative to phaseId',
  geo: "{ lat, lng, accuracyM } from the lead's phone",
  at: 'ISO date-time the punch happened, for punches sent late',
  clientId: 'Id from the sender; re-sending it does nothing twice',
}

type CrewKind = 'in' | 'next' | 'out'

for (const kind of ['in', 'next', 'out'] as CrewKind[]) {
  route(
    timesheetsRouter,
    {
      method: 'post',
      path: `/crew/${kind}`,
      tag: 'Punching',
      summary: kind === 'in' ? 'Clock a crew in (or switch them) to a job and phase.' : kind === 'next' ? 'Move a crew to the next (or a named) phase.' : 'Clock a crew out.',
      access: [CREW],
      body: CREW_BODY,
    },
    async (req) => {
      const auth = requireScope(req, CREW)
      const lead = requirePerson(requireAuth(req))
      const b = (req.body ?? {}) as Record<string, unknown>
      const ids = Array.isArray(b.personIds) ? [...new Set((b.personIds as unknown[]).map((x) => str(x, 80)).filter(Boolean))] : []
      if (!ids.length) throw badRequest('personIds must list at least one crew member.', { field: 'personIds' })
      if (ids.length > 30) throw badRequest('Punch 30 people at most at once.', { field: 'personIds' })
      const actor: Actor = { companyId: auth.companyId, apiKeyId: auth.apiKeyId, source: 'lead', punchedById: lead.id }
      const clientId = str(b.clientId, 60)
      const base: PunchInput = {
        jobId: str(b.jobId, 80) || undefined,
        phaseId: str(b.phaseId, 80) || undefined,
        phaseKey: str(b.phaseKey, 80) || undefined,
        geo: parseGeo(b.geo),
        at: optionalDate(b.at, 'at'),
      }
      const people = await prisma.person.findMany({ where: { companyId: auth.companyId, id: { in: ids } } })
      const byId = new Map(people.map((p) => [p.id, p]))
      const results = []
      for (const id of ids) {
        const person = byId.get(id)
        if (!person || !person.active) {
          results.push({ personId: id, name: person?.name ?? '', ok: false, code: 'not_found', message: 'No active person with that id.' })
          continue
        }
        try {
          const input = { ...base, clientId: clientId ? `${clientId}:${id}` : undefined }
          if (kind === 'in') await punchIn(actor, person, input)
          else if (kind === 'next') await punchNext(actor, person, input)
          else await punchOut(actor, person, input)
          const s = await personState(person)
          results.push({ personId: id, name: person.name, ok: true, onClock: s.onClock, jobName: s.open?.job.name ?? '', phaseName: s.open?.phase?.name ?? '' })
        } catch (err) {
          if (!(err instanceof ApiError)) throw err
          results.push({ personId: id, name: person.name, ok: false, code: err.code, message: err.message })
        }
      }
      return { results, punched: results.filter((r) => r.ok).length }
    },
  )
}
