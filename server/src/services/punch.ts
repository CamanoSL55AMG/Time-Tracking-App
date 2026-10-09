import type { Company, Job, Person, Phase, Prisma, Punch } from '@prisma/client'
import { prisma, type Tx } from '../db.js'
import { ApiError, badRequest, conflict, notFound } from '../errors.js'
import { dayBounds, hoursBetween } from '../lib/time.js'
import { insideFence, type Fence, type GeoStamp } from '../lib/geo.js'
import { emit } from './events.js'

// The punch engine. A person has at most one open segment. Clocking in while on the
// clock is a switch: the open segment closes at the same instant the new one opens,
// so hours per job and per phase fall straight out of the rows.

export type PunchSource = 'app' | 'api' | 'lead'

export interface PunchInput {
  jobId?: string
  jobRef?: { system: string; externalId: string }
  phaseId?: string
  phaseKey?: string
  geo?: GeoStamp | null
  at?: Date
  clientId?: string
  notes?: string
}

export interface Actor {
  companyId: string
  apiKeyId: string | null
  source: PunchSource
}

const include = { job: true, phase: true } satisfies Prisma.PunchInclude
export type PunchRow = Prisma.PunchGetPayload<{ include: typeof include }>

const FUTURE_SLACK_MS = 5 * 60_000

/** Serialise all punch changes for one person. */
async function lockPerson(tx: Tx, personId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${personId} FOR UPDATE`
}

async function resolveJob(tx: Tx, companyId: string, input: PunchInput): Promise<Job> {
  let jobId = input.jobId
  if (!jobId && input.jobRef) {
    const ref = await tx.externalRef.findUnique({
      where: {
        companyId_entity_system_externalId: {
          companyId,
          entity: 'job',
          system: input.jobRef.system,
          externalId: input.jobRef.externalId,
        },
      },
    })
    if (!ref) throw new ApiError(404, 'job_ref_unknown', `No job is linked to ${input.jobRef.system}:${input.jobRef.externalId}.`)
    jobId = ref.entityId
  }
  if (!jobId) throw badRequest('Pick a job: send jobId, or jobRef { system, externalId }.', { field: 'jobId' })
  const job = await tx.job.findFirst({ where: { id: jobId, companyId } })
  if (!job) throw notFound('Job')
  if (!job.active) throw conflict('job_inactive', `${job.name} is closed to new time.`)
  return job
}

async function resolvePhase(tx: Tx, companyId: string, input: PunchInput): Promise<Phase | null> {
  if (input.phaseId) {
    const phase = await tx.phase.findFirst({ where: { id: input.phaseId, companyId, active: true } })
    if (!phase) throw notFound('Phase')
    return phase
  }
  if (input.phaseKey) {
    const phase = await tx.phase.findFirst({ where: { key: input.phaseKey, companyId, active: true } })
    if (!phase) throw notFound(`Phase "${input.phaseKey}"`)
    return phase
  }
  // Nothing chosen: the first phase of the day.
  return tx.phase.findFirst({ where: { companyId, active: true }, orderBy: { sortOrder: 'asc' } })
}

function checkAt(at: Date): void {
  if (at.getTime() > Date.now() + FUTURE_SLACK_MS) {
    throw badRequest('A punch cannot be dated in the future.', { field: 'at' })
  }
}

const geoIn = (geo?: GeoStamp | null) => ({ inLat: geo?.lat ?? null, inLng: geo?.lng ?? null, inAccuracyM: geo?.accuracyM ?? null })
const geoOut = (geo?: GeoStamp | null) => ({ outLat: geo?.lat ?? null, outLng: geo?.lng ?? null, outAccuracyM: geo?.accuracyM ?? null })

const summary = (p: PunchRow) => ({
  id: p.id,
  personId: p.personId,
  jobId: p.jobId,
  jobName: p.job.name,
  phaseKey: p.phase?.key ?? null,
  clockIn: p.clockIn,
  clockOut: p.clockOut,
})

/** Open the next segment after closing any open one. Caller holds the person lock. */
async function openSegment(
  tx: Tx,
  actor: Actor,
  person: Person,
  job: Job,
  phase: Phase | null,
  input: PunchInput,
  at: Date,
): Promise<{ punch: PunchRow; switchedFrom: PunchRow | null }> {
  const open = await tx.punch.findFirst({ where: { personId: person.id, clockOut: null }, include })
  let switchedFrom: PunchRow | null = null

  if (open) {
    if (at.getTime() < open.clockIn.getTime()) {
      throw conflict('punch_overlap', 'That time is before the current segment started.', { openSince: open.clockIn })
    }
    switchedFrom = await tx.punch.update({ where: { id: open.id }, data: { clockOut: at, ...geoOut(input.geo) }, include })
  } else {
    const last = await tx.punch.findFirst({
      where: { personId: person.id, clockOut: { not: null } },
      orderBy: { clockOut: 'desc' },
    })
    if (last?.clockOut && at.getTime() < last.clockOut.getTime()) {
      throw conflict('punch_overlap', 'That time overlaps an earlier segment.', { lastOut: last.clockOut })
    }
  }

  const punch = await tx.punch.create({
    data: {
      companyId: actor.companyId,
      personId: person.id,
      jobId: job.id,
      phaseId: phase?.id ?? null,
      clockIn: at,
      source: actor.source,
      apiKeyId: actor.apiKeyId,
      clientId: input.clientId || null,
      notes: input.notes ?? '',
      ...geoIn(input.geo),
    },
    include,
  })

  if (switchedFrom) {
    await emit(tx, actor.companyId, 'punch.switched', { from: summary(switchedFrom), to: summary(punch) })
  } else {
    await emit(tx, actor.companyId, 'punch.started', { punch: summary(punch) })
  }
  return { punch, switchedFrom }
}

/** Clock in, or switch job / phase if already on the clock. */
export async function punchIn(actor: Actor, person: Person, input: PunchInput) {
  if (input.at) checkAt(input.at)
  return prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id)
    // "Now" is read only once this person's lock is held, so two taps that land
    // together are ordered by the lock and can never look out of sequence.
    const at = input.at ?? new Date()
    if (input.clientId) {
      const dup = await tx.punch.findUnique({
        where: { companyId_clientId: { companyId: actor.companyId, clientId: input.clientId } },
        include,
      })
      if (dup) return { punch: dup, switchedFrom: null, duplicate: true }
    }
    const job = await resolveJob(tx, actor.companyId, input)
    const phase = await resolvePhase(tx, actor.companyId, input)
    return { ...(await openSegment(tx, actor, person, job, phase, input, at)), duplicate: false }
  })
}

/** Move to the next phase of the day (or a named one) on the same job. */
export async function punchNext(actor: Actor, person: Person, input: Pick<PunchInput, 'phaseId' | 'phaseKey' | 'geo' | 'at' | 'clientId'>) {
  if (input.at) checkAt(input.at)
  return prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id)
    // "Now" is read only once this person's lock is held, so two taps that land
    // together are ordered by the lock and can never look out of sequence.
    const at = input.at ?? new Date()
    if (input.clientId) {
      const dup = await tx.punch.findUnique({
        where: { companyId_clientId: { companyId: actor.companyId, clientId: input.clientId } },
        include,
      })
      if (dup) return { punch: dup, switchedFrom: null, duplicate: true }
    }
    const open = await tx.punch.findFirst({ where: { personId: person.id, clockOut: null }, include })
    if (!open) throw conflict('not_clocked_in', 'You are not clocked in.')

    let phase: Phase | null
    if (input.phaseId || input.phaseKey) {
      phase = await resolvePhase(tx, actor.companyId, input)
    } else {
      phase = await tx.phase.findFirst({
        where: { companyId: actor.companyId, active: true, sortOrder: { gt: open.phase?.sortOrder ?? -1 } },
        orderBy: { sortOrder: 'asc' },
      })
      if (!phase) throw conflict('last_phase', 'That was the last phase of the day. Clock out instead.')
    }
    return { ...(await openSegment(tx, actor, person, open.job, phase, input, at)), duplicate: false }
  })
}

export async function punchOut(actor: Actor, person: Person, input: Pick<PunchInput, 'geo' | 'at'>) {
  if (input.at) checkAt(input.at)
  return prisma.$transaction(async (tx) => {
    await lockPerson(tx, person.id)
    // "Now" is read only once this person's lock is held, so two taps that land
    // together are ordered by the lock and can never look out of sequence.
    const at = input.at ?? new Date()
    const open = await tx.punch.findFirst({ where: { personId: person.id, clockOut: null }, include })
    if (!open) throw conflict('not_clocked_in', 'You are not clocked in.')
    if (at.getTime() < open.clockIn.getTime()) {
      throw conflict('punch_overlap', 'That time is before the current segment started.', { openSince: open.clockIn })
    }
    const punch = await tx.punch.update({ where: { id: open.id }, data: { clockOut: at, ...geoOut(input.geo) }, include })
    await emit(tx, actor.companyId, 'punch.ended', { punch: summary(punch) })
    return { punch }
  })
}

// ─── Corrections ────────────────────────────────────────────────────────────

export interface PunchPatch {
  clockIn?: Date
  clockOut?: Date | null
  jobId?: string
  phaseId?: string | null
  notes?: string
}

const auditShape = (p: Punch) => ({
  clockIn: p.clockIn,
  clockOut: p.clockOut,
  jobId: p.jobId,
  phaseId: p.phaseId,
  notes: p.notes,
})

/** Correct a segment. Every change is recorded with who made it and why. */
export async function editPunch(
  actor: { companyId: string; personId: string | null; apiKeyId: string | null },
  punchId: string,
  patch: PunchPatch,
  reason: string,
) {
  if (!reason.trim()) throw badRequest('A reason is required to change a punch.', { field: 'reason' })
  return prisma.$transaction(async (tx) => {
    const before = await tx.punch.findFirst({ where: { id: punchId, companyId: actor.companyId } })
    if (!before) throw notFound('Punch')
    await lockPerson(tx, before.personId)

    const clockIn = patch.clockIn ?? before.clockIn
    const clockOut = patch.clockOut === undefined ? before.clockOut : patch.clockOut
    checkAt(clockIn)
    if (clockOut) checkAt(clockOut)
    if (clockOut && clockOut.getTime() <= clockIn.getTime()) {
      throw badRequest('Clock-out must be after clock-in.', { field: 'clockOut' })
    }
    if (!clockOut) {
      const otherOpen = await tx.punch.findFirst({ where: { personId: before.personId, clockOut: null, id: { not: before.id } } })
      if (otherOpen) throw conflict('already_open', 'This person already has an open segment.')
    }
    // No overlap with the person's other segments.
    const clash = await tx.punch.findFirst({
      where: {
        personId: before.personId,
        id: { not: before.id },
        clockIn: clockOut ? { lt: clockOut } : undefined,
        OR: [{ clockOut: null }, { clockOut: { gt: clockIn } }],
      },
    })
    if (clash) throw conflict('punch_overlap', 'The new times overlap another segment.', { overlaps: clash.id })

    if (patch.jobId) {
      const job = await tx.job.findFirst({ where: { id: patch.jobId, companyId: actor.companyId } })
      if (!job) throw notFound('Job')
    }
    if (patch.phaseId) {
      const phase = await tx.phase.findFirst({ where: { id: patch.phaseId, companyId: actor.companyId } })
      if (!phase) throw notFound('Phase')
    }

    const after = await tx.punch.update({
      where: { id: before.id },
      data: {
        clockIn,
        clockOut,
        jobId: patch.jobId ?? before.jobId,
        phaseId: patch.phaseId === undefined ? before.phaseId : patch.phaseId,
        notes: patch.notes ?? before.notes,
      },
      include,
    })
    await tx.punchEdit.create({
      data: {
        punchId: before.id,
        editedById: actor.personId,
        editedByKeyId: actor.apiKeyId,
        reason: reason.trim(),
        before: JSON.parse(JSON.stringify(auditShape(before))) as Prisma.InputJsonValue,
        after: JSON.parse(JSON.stringify(auditShape(after))) as Prisma.InputJsonValue,
      },
    })
    await emit(tx, actor.companyId, 'punch.edited', { punch: summary(after), reason: reason.trim() })
    return after
  })
}

// ─── Views ──────────────────────────────────────────────────────────────────

const shopFence = (c: Company): Fence | null =>
  c.shopLat !== null && c.shopLng !== null ? { lat: c.shopLat, lng: c.shopLng, radiusM: c.shopRadiusM } : null

const stampIn = (p: Punch): GeoStamp | null =>
  p.inLat !== null && p.inLng !== null ? { lat: p.inLat, lng: p.inLng, accuracyM: p.inAccuracyM ?? undefined } : null

/** One person's day: open segment, today's segments, totals, and what "Next" would do. */
export async function personState(person: Person) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: person.companyId } })
  const now = new Date()
  const { start, end, date } = dayBounds(now, company.timezone)
  const [open, today, phases, assignments] = await Promise.all([
    prisma.punch.findFirst({ where: { personId: person.id, clockOut: null }, include }),
    prisma.punch.findMany({
      where: { personId: person.id, clockIn: { gte: start, lt: end } },
      orderBy: { clockIn: 'asc' },
      include,
    }),
    prisma.phase.findMany({ where: { companyId: person.companyId, active: true }, orderBy: { sortOrder: 'asc' } }),
    prisma.assignment.findMany({
      where: { personId: person.id, date },
      include: { job: true },
      orderBy: [{ shopTime: 'asc' }, { createdAt: 'asc' }],
    }),
  ])

  const byJob = new Map<string, { jobId: string; jobName: string; hours: number }>()
  for (const p of today) {
    const row = byJob.get(p.jobId) ?? { jobId: p.jobId, jobName: p.job.name, hours: 0 }
    row.hours += hoursBetween(p.clockIn, p.clockOut, now)
    byJob.set(p.jobId, row)
  }

  // On the clock: the phase "Next" moves to (null after the last one).
  // Off the clock: the phase to suggest. Back from a break, that is the phase the
  // person was in; at the start of the day, the first one.
  const lastToday = today.length ? today[today.length - 1] : null
  const nextPhase = open
    ? phases.find((ph) => ph.sortOrder > (open.phase?.sortOrder ?? -1)) ?? null
    : phases.find((ph) => ph.id === lastToday?.phaseId) ?? phases[0] ?? null

  return {
    date,
    timezone: company.timezone,
    onClock: Boolean(open),
    open,
    today,
    hoursToday: today.reduce((sum, p) => sum + hoursBetween(p.clockIn, p.clockOut, now), 0),
    byJob: [...byJob.values()],
    nextPhase,
    phases,
    // Today's schedule from the job calendar; closed jobs are not offered.
    assignments: assignments.map((a) => ({
      id: a.id,
      title: a.title,
      shopTime: a.shopTime,
      job: a.job && a.job.active ? a.job : null,
    })),
    asOf: now,
  }
}

export interface BoardRow {
  personId: string
  name: string
  email: string
  onClock: boolean
  jobId: string | null
  jobName: string
  phaseKey: string | null
  phaseName: string
  phaseIndex: number | null
  since: Date | null
  lastOut: Date | null
  hoursToday: number
  atShop: boolean | null
}

/** Tower board: everyone who has punched today, who is on the clock first. */
export async function board(companyId: string) {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  const now = new Date()
  const { start, end, date } = dayBounds(now, company.timezone)
  const [punches, phases] = await Promise.all([
    prisma.punch.findMany({
      // Today's segments, plus anything still open from before midnight.
      where: { companyId, OR: [{ clockIn: { gte: start, lt: end } }, { clockOut: null }] },
      orderBy: { clockIn: 'asc' },
      include: { job: true, phase: true, person: true },
    }),
    prisma.phase.findMany({ where: { companyId, active: true }, orderBy: { sortOrder: 'asc' } }),
  ])
  const index = new Map(phases.map((ph, i) => [ph.id, i]))
  const fence = shopFence(company)
  const rows = new Map<string, BoardRow>()

  for (const p of punches) {
    let r = rows.get(p.personId)
    if (!r) {
      r = {
        personId: p.personId,
        name: p.person.name,
        email: p.person.email,
        onClock: false,
        jobId: null,
        jobName: '',
        phaseKey: null,
        phaseName: '',
        phaseIndex: null,
        since: null,
        lastOut: null,
        hoursToday: 0,
        atShop: null,
      }
      rows.set(p.personId, r)
    }
    r.hoursToday += hoursBetween(p.clockIn < start ? start : p.clockIn, p.clockOut, now)
    if (!p.clockOut || !r.onClock) {
      r.jobId = p.jobId
      r.jobName = p.job.name
      r.phaseKey = p.phase?.key ?? null
      r.phaseName = p.phase?.name ?? ''
      r.phaseIndex = p.phaseId ? index.get(p.phaseId) ?? null : null
    }
    if (!p.clockOut) {
      r.onClock = true
      r.since = p.clockIn
      r.atShop = insideFence(stampIn(p), fence)
    } else if (!r.onClock) {
      r.lastOut = p.clockOut
    }
  }

  return {
    date,
    asOf: now,
    phaseCount: phases.length,
    rows: [...rows.values()].sort((a, b) => Number(b.onClock) - Number(a.onClock) || a.name.localeCompare(b.name)),
  }
}

export const punchInclude = include
