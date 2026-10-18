import type { ChangeRequest, Person, Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { localDate } from '../lib/time.js'
import { emit } from './events.js'
import { addSegmentTx, editPunchTx } from './punch.js'
import { weekOf } from './timesheets.js'

// Change requests: a person asks for their own time to be fixed, a supervisor
// decides. Approving applies the change as an ordinary audited correction, so the
// segment's history says who asked, who approved and why.

export interface RequestInput {
  punchId?: string
  clockIn?: Date
  clockOut?: Date
  jobId?: string
  phaseId?: string | null
  notes?: string
  reason: string
}

const segInclude = { job: { select: { id: true, name: true, code: true } }, phase: { select: { id: true, key: true, name: true, short: true } } } as const

/** A person asks for a change to their own time. */
export async function createRequest(person: Person, input: RequestInput) {
  const reason = input.reason.trim()
  if (!reason) throw badRequest('Say why the change is needed.', { field: 'reason' })
  const company = await prisma.company.findUniqueOrThrow({ where: { id: person.companyId } })
  const weekFor = (d: Date) => weekOf(localDate(d, company.timezone), company.weekStartDay)

  if (input.punchId) {
    const seg = await prisma.punch.findFirst({ where: { id: input.punchId, companyId: person.companyId }, include: segInclude })
    if (!seg) throw notFound('Segment')
    if (seg.personId !== person.id) throw forbidden('You can ask for changes to your own time only.')
    const changes =
      (input.clockIn && input.clockIn.getTime() !== seg.clockIn.getTime()) ||
      (input.clockOut && input.clockOut.getTime() !== seg.clockOut?.getTime()) ||
      (input.jobId && input.jobId !== seg.jobId) ||
      (input.phaseId !== undefined && input.phaseId !== seg.phaseId) ||
      (input.notes !== undefined && input.notes !== seg.notes)
    if (!changes) throw badRequest('Nothing to change: the request matches the segment as it is.')
    const pending = await prisma.changeRequest.findFirst({ where: { punchId: seg.id, status: 'pending' } })
    if (pending) throw conflict('request_pending', 'There is already a change waiting for approval on this segment. Withdraw it first to ask for something else.')
    await checkRefs(person.companyId, input)
    return prisma.$transaction(async (tx) => {
      const req = await tx.changeRequest.create({
        data: {
          companyId: person.companyId,
          personId: person.id,
          requestedById: person.id,
          kind: 'edit',
          punchId: seg.id,
          weekStart: weekFor(seg.clockIn),
          clockIn: input.clockIn && input.clockIn.getTime() !== seg.clockIn.getTime() ? input.clockIn : null,
          clockOut: input.clockOut && input.clockOut.getTime() !== seg.clockOut?.getTime() ? input.clockOut : null,
          jobId: input.jobId && input.jobId !== seg.jobId ? input.jobId : null,
          phaseId: input.phaseId !== undefined && input.phaseId !== seg.phaseId ? input.phaseId : null,
          notes: input.notes !== undefined && input.notes !== seg.notes ? input.notes : null,
          reason,
          before: JSON.parse(
            JSON.stringify({
              clockIn: seg.clockIn,
              clockOut: seg.clockOut,
              jobId: seg.jobId,
              jobName: seg.job.name,
              phaseId: seg.phaseId,
              phaseName: seg.phase?.name ?? null,
              notes: seg.notes,
            }),
          ) as Prisma.InputJsonValue,
        },
      })
      await emit(tx, person.companyId, 'request.created', { id: req.id, personId: person.id, kind: 'edit', punchId: seg.id })
      return req
    })
  }

  // Missing time: a whole segment that was never punched.
  if (!input.clockIn || !input.clockOut || !input.jobId) throw badRequest('Missing time needs a start, an end and a job.', { field: 'clockIn' })
  if (input.clockOut.getTime() <= input.clockIn.getTime()) throw badRequest('The end must be after the start.', { field: 'clockOut' })
  if (input.clockIn.getTime() > Date.now()) throw badRequest('Missing time cannot be in the future.', { field: 'clockIn' })
  await checkRefs(person.companyId, input)
  return prisma.$transaction(async (tx) => {
    const req = await tx.changeRequest.create({
      data: {
        companyId: person.companyId,
        personId: person.id,
        requestedById: person.id,
        kind: 'add',
        weekStart: weekFor(input.clockIn!),
        clockIn: input.clockIn,
        clockOut: input.clockOut,
        jobId: input.jobId,
        phaseId: input.phaseId ?? null,
        notes: input.notes ?? null,
        reason,
      },
    })
    await emit(tx, person.companyId, 'request.created', { id: req.id, personId: person.id, kind: 'add' })
    return req
  })
}

async function checkRefs(companyId: string, input: RequestInput) {
  if (input.jobId) {
    const job = await prisma.job.findFirst({ where: { id: input.jobId, companyId } })
    if (!job) throw notFound('Job')
  }
  if (input.phaseId) {
    const phase = await prisma.phase.findFirst({ where: { id: input.phaseId, companyId } })
    if (!phase) throw notFound('Phase')
  }
}

/** Requests as people read them: names instead of ids, before and after side by side. */
export async function viewRequests(rows: ChangeRequest[]) {
  const personIds = [...new Set(rows.flatMap((r) => [r.personId, r.requestedById, r.decidedById]).filter((x): x is string => Boolean(x)))]
  const jobIds = [...new Set(rows.map((r) => r.jobId).filter((x): x is string => Boolean(x)))]
  const phaseIds = [...new Set(rows.map((r) => r.phaseId).filter((x): x is string => Boolean(x)))]
  const [people, jobs, phases] = await Promise.all([
    prisma.person.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } }),
    prisma.job.findMany({ where: { id: { in: jobIds } }, select: { id: true, name: true } }),
    prisma.phase.findMany({ where: { id: { in: phaseIds } }, select: { id: true, name: true } }),
  ])
  const name = new Map(people.map((p) => [p.id, p.name]))
  const job = new Map(jobs.map((j) => [j.id, j.name]))
  const phase = new Map(phases.map((p) => [p.id, p.name]))
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind as 'edit' | 'add',
    person: { id: r.personId, name: name.get(r.personId) ?? '' },
    requestedBy: name.get(r.requestedById) ?? '',
    punchId: r.punchId,
    weekStart: r.weekStart,
    before: r.before as null | { clockIn: string; clockOut: string | null; jobId: string; jobName: string; phaseId: string | null; phaseName: string | null; notes: string },
    change: {
      clockIn: r.clockIn,
      clockOut: r.clockOut,
      jobId: r.jobId,
      jobName: r.jobId ? job.get(r.jobId) ?? '' : null,
      phaseId: r.phaseId,
      phaseName: r.phaseId ? phase.get(r.phaseId) ?? '' : null,
      notes: r.notes,
    },
    reason: r.reason,
    status: r.status as 'pending' | 'approved' | 'rejected' | 'withdrawn',
    decidedBy: r.decidedById ? name.get(r.decidedById) ?? '' : null,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    createdAt: r.createdAt,
  }))
}

export async function listRequests(companyId: string, opts: { status?: string; personId?: string; weekStart?: string; limit?: number }) {
  const rows = await prisma.changeRequest.findMany({
    where: { companyId, status: opts.status || undefined, personId: opts.personId || undefined, weekStart: opts.weekStart || undefined },
    orderBy: { createdAt: opts.status === 'pending' ? 'asc' : 'desc' },
    take: opts.limit ?? 100,
  })
  return viewRequests(rows)
}

/** The person takes back a request nobody has decided yet. */
export async function withdrawRequest(person: Person, id: string) {
  const req = await prisma.changeRequest.findFirst({ where: { id, companyId: person.companyId } })
  if (!req) throw notFound('Request')
  if (req.personId !== person.id) throw forbidden('That is not your request.')
  if (req.status !== 'pending') throw conflict('request_decided', 'This request has already been decided.')
  await prisma.changeRequest.update({ where: { id }, data: { status: 'withdrawn', decidedAt: new Date() } })
  return (await viewRequests([{ ...req, status: 'withdrawn', decidedAt: new Date() }]))[0]
}

/** A supervisor approves (the change is applied) or rejects (with a note). */
export async function decideRequest(approver: Person, id: string, decision: 'approve' | 'reject', note: string) {
  const req = await prisma.changeRequest.findFirst({ where: { id, companyId: approver.companyId } })
  if (!req) throw notFound('Request')
  if (req.status !== 'pending') throw conflict('request_decided', 'This request has already been decided.')
  if (req.requestedById === approver.id && approver.role !== 'admin') {
    throw conflict('own_request', 'Someone else has to approve a change to your own time.')
  }
  if (decision === 'reject') {
    if (!note.trim()) throw badRequest('Say why the change is turned down, so the person knows what to do.', { field: 'note' })
    const updated = await prisma.$transaction(async (tx) => {
      const u = await tx.changeRequest.update({ where: { id }, data: { status: 'rejected', decidedById: approver.id, decidedAt: new Date(), decisionNote: note.trim() } })
      await emit(tx, approver.companyId, 'request.decided', { id, personId: req.personId, status: 'rejected', by: approver.id })
      return u
    })
    return (await viewRequests([updated]))[0]
  }

  const requester = await prisma.person.findUnique({ where: { id: req.requestedById }, select: { name: true } })
  const why = `${req.reason} (asked by ${requester?.name ?? 'them'}, approved by ${approver.name}${note.trim() ? `: ${note.trim()}` : ''})`
  const actor = { companyId: approver.companyId, personId: approver.id, apiKeyId: null }
  const updated = await prisma.$transaction(async (tx) => {
    let resultPunchId: string
    if (req.kind === 'add') {
      const p = await addSegmentTx(tx, actor, req.personId, { clockIn: req.clockIn!, clockOut: req.clockOut!, jobId: req.jobId!, phaseId: req.phaseId, notes: req.notes ?? '' }, why)
      resultPunchId = p.id
    } else {
      const p = await editPunchTx(
        tx,
        actor,
        req.punchId!,
        {
          clockIn: req.clockIn ?? undefined,
          clockOut: req.clockOut ?? undefined,
          jobId: req.jobId ?? undefined,
          phaseId: req.phaseId ?? undefined,
          notes: req.notes ?? undefined,
        },
        why,
      )
      resultPunchId = p.id
    }
    const u = await tx.changeRequest.update({
      where: { id },
      data: { status: 'approved', decidedById: approver.id, decidedAt: new Date(), decisionNote: note.trim(), resultPunchId },
    })
    await emit(tx, approver.companyId, 'request.decided', { id, personId: req.personId, status: 'approved', by: approver.id, punchId: resultPunchId })
    return u
  })
  return (await viewRequests([updated]))[0]
}
