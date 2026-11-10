import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../db.js'
import { bool, route, str } from '../api.js'
import { badRequest, conflict, forbidden } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { DIVISION_ADMIN, isRole, KEYS_MANAGE, PEOPLE_ROLES, ROLE_LIST } from '../auth/apiKeys.js'
import { cleanDivision, isLimited, isVisible, peopleWhere } from '../auth/division.js'
import { emit } from '../services/events.js'
import { publicPerson } from './auth.js'
import { config } from '../config.js'
import { ApiError } from '../errors.js'
import { isYmd, localDate } from '../lib/time.js'
import { isWorkerType, workerTypeChange } from '../services/workerType.js'

export const peopleRouter = Router()

route(
  peopleRouter,
  { method: 'get', path: '/people', tag: 'People', summary: 'The roster. A division admin gets their own division only.', access: ['people:read'], query: { active: 'true or false' }, division: true },
  async (req) => {
    const auth = requireScope(req, 'people:read')
    const people = await prisma.person.findMany({
      where: { ...peopleWhere(auth), active: bool(req.query.active) },
      orderBy: { name: 'asc' },
    })
    // Division names already in use, for the picker. A division admin is told only their own.
    const divisions = isLimited(auth)
      ? [auth.division].filter((d): d is string => Boolean(d))
      : (await prisma.person.findMany({ where: { companyId: auth.companyId, division: { not: '' } }, select: { division: true }, distinct: ['division'], orderBy: { division: 'asc' } })).map((p) => p.division)
    return { data: people.map(publicPerson), contractorsEnabled: config.contractorsEnabled, divisions }
  },
)

route(
  peopleRouter,
  {
    method: 'put',
    path: '/people/by-email/:email',
    tag: 'People',
    summary: 'Create or update a person by email. Safe to repeat.',
    access: ['people:write'],
    division: true,
    body: {
      name: 'Display name',
      initials: 'Initials as written on the job calendar',
      role: 'tech | lead | manager | payroll | admin | division_admin (admin and division_admin need a signed-in admin or a key with people:roles). A division admin may set tech or lead only',
      division: 'The group inside the company this person belongs to, e.g. "Stage Forge"; empty for none. Needs a signed-in admin or a key with people:roles. A division admin adds people to their own division and cannot move them',
      active: 'false to stop the person signing in or punching',
      password: 'Set an initial password (signed-in admins only). They must change it at first sign-in unless mustChangePassword is false',
      mustChangePassword: 'true or false: whether they must pick a new password at their next sign-in (signed-in admins only)',
      workerType: 'employee (W-2) | contractor (1099). Only with CONTRACTORS_ENABLED=true',
      workerTypeFrom: 'YYYY-MM-DD the worker type starts (company time). A change defaults to today',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'people:write')
    const email = str(req.params.email, 320).toLowerCase()
    if (!email.includes('@')) throw badRequest('That is not an email address.', { field: 'email' })
    const isAdmin = auth.via === 'session' && auth.scopes.has(KEYS_MANAGE)
    // A key with people:roles (AIC Terminal's) may set any role, admin included.
    // Passwords stay with signed-in admins.
    const mayManageAdmins = isAdmin || (auth.via === 'key' && auth.scopes.has(PEOPLE_ROLES))

    const existing = await prisma.person.findUnique({ where: { email } })
    if (existing && existing.companyId !== auth.companyId) throw forbidden('That email belongs to another company.')

    const role = req.body?.role === undefined ? undefined : String(req.body.role)
    if (role !== undefined && !isRole(role)) throw badRequest(`role must be ${ROLE_LIST}.`, { field: 'role' })
    // Only a signed-in admin hands out or takes away the admin and division admin roles.
    const privileged = (r: string | undefined) => r === 'admin' || r === DIVISION_ADMIN
    if (!mayManageAdmins && (privileged(role) || (privileged(existing?.role) && role !== undefined))) {
      throw forbidden('Only a signed-in admin can change who is an admin or a division admin.')
    }
    const active = bool(req.body?.active)
    if (!mayManageAdmins && privileged(existing?.role) && active === false) throw forbidden('Only a signed-in admin can deactivate an admin or a division admin.')

    // Division. Who is in which division decides what a division admin sees, so only
    // those who may manage admins set it. A division admin (Art, 2026-11-10) keeps their
    // own roster: adds people (always into their division), switches them on and off,
    // and makes them tech or lead. Nothing else, and nobody outside the division.
    const limited = isLimited(auth)
    let division = req.body?.division === undefined ? undefined : cleanDivision(req.body.division)
    if (limited) {
      if (!auth.division) throw forbidden('Your account has no division set. Ask an admin.')
      if (existing && !(await isVisible(auth, existing.id))) throw forbidden('That email is already in Logbook outside your division. Ask an admin.')
      if (division !== undefined && division !== auth.division) throw forbidden('You can add people to your own division only.')
      if (role !== undefined && role !== 'tech' && role !== 'lead') throw forbidden('You can make someone a tech or a crew lead. Ask an admin for any other role.')
      if (existing && existing.role !== 'tech' && existing.role !== 'lead' && (role !== undefined || active !== undefined)) {
        throw forbidden('You can change techs and crew leads only.')
      }
      if (req.body?.workerType !== undefined || req.body?.workerTypeFrom !== undefined) throw forbidden('How someone is paid is set by payroll or an admin.')
      division = existing ? undefined : auth.division
    } else if (division !== undefined && division !== (existing?.division ?? '') && !mayManageAdmins) {
      throw forbidden('Only a signed-in admin can change which division someone is in.')
    }
    const roleAfter = role ?? existing?.role ?? 'tech'
    const divisionAfter = division ?? existing?.division ?? ''
    if (roleAfter === DIVISION_ADMIN && !divisionAfter && (role !== undefined || division !== undefined)) {
      throw badRequest('A division admin needs a division. Set the division first.', { field: 'division' })
    }

    // Never leave the company without an admin who can sign in.
    if (existing?.role === 'admin' && existing.active && ((role !== undefined && role !== 'admin') || active === false)) {
      const others = await prisma.person.count({ where: { companyId: auth.companyId, role: 'admin', active: true, id: { not: existing.id } } })
      if (others === 0) throw conflict('last_admin', 'This is the only admin. Make someone else an admin first.')
    }

    let passwordHash: string | undefined
    if (req.body?.password !== undefined) {
      if (!isAdmin) throw forbidden('Only a signed-in admin can set a password for someone.')
      const pw = String(req.body.password)
      if (pw.length < 10) throw badRequest('The password needs at least 10 characters.', { field: 'password' })
      passwordHash = await bcrypt.hash(pw, 12)
    }
    // A password an admin chose is known to the admin, so the person picks their own
    // at first sign-in. An admin may also flag or unflag someone without a new password.
    let mustChangePassword: boolean | undefined = passwordHash ? true : undefined
    if (req.body?.mustChangePassword !== undefined) {
      if (!isAdmin) throw forbidden('Only a signed-in admin can change whether someone must change their password.')
      if (typeof req.body.mustChangePassword !== 'boolean') throw badRequest('mustChangePassword must be true or false.', { field: 'mustChangePassword' })
      mustChangePassword = req.body.mustChangePassword
    }

    // W-2 or 1099 (services/workerType.ts).
    let worker: { workerType: string; workerTypeFrom: string | null; priorWorkerType: string | null } | undefined
    const wantType = req.body?.workerType
    const wantFrom = req.body?.workerTypeFrom
    if (wantType !== undefined || wantFrom !== undefined) {
      if (!config.contractorsEnabled) {
        throw new ApiError(403, 'contractors_off', 'Contractors are turned off. Set CONTRACTORS_ENABLED=true in server/.env and restart to turn them on.')
      }
      const type = wantType === undefined ? (existing?.workerType ?? 'employee') : String(wantType)
      if (!isWorkerType(type)) throw badRequest('workerType must be employee or contractor.', { field: 'workerType' })
      const from = wantFrom === undefined || wantFrom === null || wantFrom === '' ? null : String(wantFrom)
      if (from !== null && !isYmd(from)) throw badRequest('workerTypeFrom must be a date, YYYY-MM-DD.', { field: 'workerTypeFrom' })
      const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
      worker = workerTypeChange(existing, type, from, localDate(new Date(), company.timezone))
    }

    const name = str(req.body?.name, 200)
    const initials = req.body?.initials === undefined ? undefined : str(req.body.initials, 8).toUpperCase()

    const person = await prisma.$transaction(async (tx) => {
      const saved = existing
        ? await tx.person.update({
            where: { id: existing.id },
            data: { name: name || undefined, initials, role, division, active, passwordHash, mustChangePassword, ...worker },
          })
        : await tx.person.create({
            data: {
              companyId: auth.companyId,
              email,
              name: name || email,
              initials: initials ?? '',
              role: role ?? 'tech',
              division: division ?? '',
              active: active ?? true,
              passwordHash,
              mustChangePassword,
              ...worker,
            },
          })
      await emit(tx, auth.companyId, 'person.upserted', { person: { id: saved.id, email: saved.email, name: saved.name, role: saved.role, division: saved.division, active: saved.active, workerType: saved.workerType } })
      return saved
    })
    return { created: !existing, person: publicPerson(person) }
  },
)
