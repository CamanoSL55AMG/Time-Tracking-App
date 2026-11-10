import { Router } from 'express'
import { prisma } from '../db.js'
import { bool, limitOf, optionalDate, requiredStr, route, str } from '../api.js'
import { ApiError, badRequest } from '../errors.js'
import { requireAuth, requirePerson, requireScope } from '../auth/middleware.js'
import { APPROVE, CREW, FIX_APPROVE, SELF } from '../auth/apiKeys.js'
import { assertVisible, peopleWhere, visiblePeople } from '../auth/division.js'
import { parseGeo } from '../lib/geo.js'
import { addDays, dayBounds, isYmd, startOfLocalDay } from '../lib/time.js'
import { approveWeek, personWeek, reopenWeek, signWeek, weekBounds, weekSheet } from '../services/timesheets.js'
import { findExceptions } from '../services/exceptions.js'
import { createRequest, decideRequest, listRequests, withdrawRequest } from '../services/requests.js'
import { editOwnTimes, personState, punchIn, punchNext, punchOut, selfEditFrom, type Actor, type PunchInput } from '../services/punch.js'
import { listSelfEdits, markReviewed, waitingByPerson, type ReviewStatus } from '../services/selfEdits.js'

export const timesheetsRouter = Router()

const WEEK = { week: 'Any date in the week, YYYY-MM-DD. Defaults to this week' }

/** A person's week plus the change requests made for it, and the times they fixed themselves. */
async function weekWithRequests(companyId: string, personId: string, week: string | undefined) {
  const w = await personWeek(companyId, personId, week)
  const { start, end } = weekBounds(w.weekStart, w.timezone)
  const [requests, selfEdits] = await Promise.all([
    listRequests(companyId, { personId, weekStart: w.weekStart }),
    listSelfEdits(companyId, { status: 'all', personId, from: start, to: end }),
  ])
  return {
    ...w,
    requests,
    selfEdits,
    // First day the person may fix their own time on (the start of the open pay
    // period); null when that is switched off.
    selfEditFrom: selfEditFrom(new Date(), w.timezone),
  }
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
  { method: 'get', path: '/timesheets', tag: 'Timesheets', summary: "Everyone's week: hours per day, sign-off state and problems to look at.", access: ['punch:read'], query: WEEK, division: true },
  async (req) => {
    const auth = requireScope(req, 'punch:read')
    const companyId = auth.companyId
    const ids = await visiblePeople(auth)
    const sheet = await weekSheet(companyId, str(req.query.week, 10) || undefined, ids ? [...ids] : undefined)
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
    const { start, end } = weekBounds(sheet.weekStart, company.timezone)
    // Times people fixed themselves this week that nobody has looked at yet.
    const waiting = await waitingByPerson(companyId, start, end)
    const rows = sheet.rows.map((r) => ({ ...r, editsToReview: waiting.get(r.person.id) ?? 0 }))
    return { ...sheet, rows, counts: { ...sheet.counts, editsToReview: rows.reduce((n, r) => n + r.editsToReview, 0) } }
  },
)

route(
  timesheetsRouter,
  { method: 'get', path: '/timesheets/:personId', tag: 'Timesheets', summary: "One person's week in detail.", access: ['punch:read'], query: WEEK, division: true },
  async (req) => {
    const auth = requireScope(req, 'punch:read')
    await assertVisible(auth, req.params.personId)
    return weekWithRequests(auth.companyId, req.params.personId, str(req.query.week, 10) || undefined)
  },
)

route(
  timesheetsRouter,
  {
    method: 'post',
    path: '/timesheets/approve',
    tag: 'Timesheets',
    summary: 'Approve a week for one or more people, any time. Approved days are locked.',
    access: [APPROVE],
    division: true,
    body: {
      personIds: 'People to approve',
      ...WEEK,
      through: 'Optional last day to approve (YYYY-MM-DD). Default: the whole week once it is over, otherwise through yesterday',
      note: 'Optional note kept with the approval',
    },
  },
  async (req) => {
    const auth = requireScope(req, APPROVE)
    const approver = requirePerson(auth)
    const ids = Array.isArray(req.body?.personIds) ? (req.body.personIds as unknown[]).map((x) => str(x, 80)).filter(Boolean) : []
    if (!ids.length) throw badRequest('personIds must list at least one person.', { field: 'personIds' })
    if (ids.length > 200) throw badRequest('Approve 200 people at most per call.', { field: 'personIds' })
    for (const id of ids) await assertVisible(auth, id)
    const results = await approveWeek(auth.companyId, approver.id, ids, str(req.body?.week, 10) || undefined, str(req.body?.note, 500), str(req.body?.through, 10) || undefined)
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
    division: true,
    body: { personId: 'Whose week', ...WEEK, reason: 'Why it is being reopened (required)' },
  },
  async (req) => {
    const auth = requireScope(req, APPROVE)
    const approver = requirePerson(auth)
    const personId = requiredStr(req.body?.personId, 'personId', 80)
    await assertVisible(auth, personId)
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
    division: true,
  },
  async (req) => {
    const auth = requireScope(req, 'punch:read')
    const status = str(req.query.status, 20)
    if (status && !['pending', 'approved', 'rejected', 'withdrawn'].includes(status)) throw badRequest('status must be pending, approved, rejected or withdrawn.', { field: 'status' })
    const personId = str(req.query.personId, 80) || undefined
    if (personId) await assertVisible(auth, personId)
    const ids = await visiblePeople(auth)
    return { data: await listRequests(auth.companyId, { status: status || undefined, personId, personIds: ids ? [...ids] : undefined }) }
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
      access: [FIX_APPROVE],
      body: { note: decision === 'approve' ? 'Optional note' : 'Why it is turned down (required)' },
      division: true,
    },
    async (req) => {
      const auth = requireScope(req, FIX_APPROVE)
      if (auth.division !== null) {
        const target = await prisma.changeRequest.findFirst({ where: { id: req.params.id, companyId: auth.companyId }, select: { personId: true } })
        await assertVisible(auth, target?.personId, 'Change request')
      }
      return { request: await decideRequest(requirePerson(auth), req.params.id, decision, str(req.body?.note, 500)) }
    },
  )
}

// ─── Fixing your own time ───────────────────────────────────────────────────
// A tech corrects their own punch times back to the start of the open pay period
// (Art, 2026-11-09). No approval first: the change counts at once, keeps the old
// times in the segment's history, and waits on Review until a supervisor or admin
// marks it looked at.

route(
  timesheetsRouter,
  {
    method: 'patch',
    path: '/me/punches/:id',
    tag: 'Timesheets',
    summary: 'Fix the start or end of one of your own segments in the open pay period. A switch moves both sides together.',
    access: [SELF],
    body: {
      clockIn: 'New start (ISO date-time)',
      clockOut: 'New end (ISO date-time). Closes a segment left open on an earlier day',
      keepJoined: 'Default true: a segment that meets this one (a switch) moves with it. false leaves it where it is (time off in between)',
      reason: 'What happened (required)',
    },
  },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const b = (req.body ?? {}) as Record<string, unknown>
    if (b.clockOut === null) throw badRequest('A segment cannot be reopened here. Clock in on the clock screen instead.', { field: 'clockOut' })
    const result = await editOwnTimes(
      { person, apiKeyId: auth.apiKeyId },
      req.params.id,
      { clockIn: optionalDate(b.clockIn, 'clockIn'), clockOut: optionalDate(b.clockOut, 'clockOut') },
      str(b.reason, 500),
      bool(b.keepJoined) ?? true,
    )
    return result
  },
)

route(
  timesheetsRouter,
  {
    method: 'get',
    path: '/edits',
    tag: 'Timesheets',
    summary: 'Times people fixed themselves: waiting to be looked at (default), looked at, or all.',
    access: ['punch:read'],
    query: { status: 'waiting, reviewed or all. Defaults to waiting', personId: 'Only this person', limit: 'At most this many, 200 by default' },
    division: true,
  },
  async (req) => {
    const auth = requireScope(req, 'punch:read')
    const status = (str(req.query.status, 20) || 'waiting') as ReviewStatus
    if (!['waiting', 'reviewed', 'all'].includes(status)) throw badRequest('status must be waiting, reviewed or all.', { field: 'status' })
    const personId = str(req.query.personId, 80) || undefined
    if (personId) await assertVisible(auth, personId)
    const visible = await visiblePeople(auth)
    return { data: await listSelfEdits(auth.companyId, { status, personId, personIds: visible ? [...visible] : undefined, limit: limitOf(req.query.limit, 200, 500) }) }
  },
)

route(
  timesheetsRouter,
  {
    method: 'post',
    path: '/edits/reviewed',
    tag: 'Timesheets',
    summary: 'Mark times people fixed themselves as looked at.',
    access: [FIX_APPROVE],
    body: { ids: 'Edit ids from GET /edits' },
    division: true,
  },
  async (req) => {
    const auth = requireScope(req, FIX_APPROVE)
    const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map((x) => str(x, 80)).filter(Boolean) : []
    if (auth.division !== null && ids.length) {
      // A division admin marks only edits to their own division's time.
      const targets = await prisma.punchEdit.findMany({ where: { id: { in: ids.slice(0, 500) }, punch: { companyId: auth.companyId } }, select: { punch: { select: { personId: true } } } })
      for (const t of targets) await assertVisible(auth, t.punch.personId, 'Edit')
    }
    return markReviewed(requirePerson(auth), ids)
  },
)

route(
  timesheetsRouter,
  {
    method: 'get',
    path: '/reports/exceptions',
    tag: 'Views',
    summary: 'Punches to look at: missed clock-outs, long days, punches away from the site, corrections, punches sent late.',
    access: ['reports:read', 'punch:read'],
    query: { from: 'YYYY-MM-DD, defaults to 7 days ago', to: 'YYYY-MM-DD inclusive, defaults to today', personId: 'Only this person' },
    division: true,
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
    const personId = str(req.query.personId, 80) || undefined
    if (personId) await assertVisible(auth, personId)
    const ids = await visiblePeople(auth)
    return { from: fromRaw, to: toRaw, data: await findExceptions(auth.companyId, { from, to, personId, personIds: ids ? [...ids] : undefined }) }
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
      division: true,
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
      // A division admin punches a crew from their own division only; anyone else comes back as not_found.
      const people = await prisma.person.findMany({ where: { AND: [peopleWhere(auth), { id: { in: ids } }] } })
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
