import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../db.js'
import { bool, route, str } from '../api.js'
import { badRequest, conflict, forbidden } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { isRole, KEYS_MANAGE, PEOPLE_ROLES } from '../auth/apiKeys.js'
import { emit } from '../services/events.js'
import { publicPerson } from './auth.js'
import { config } from '../config.js'
import { ApiError } from '../errors.js'
import { isYmd, localDate } from '../lib/time.js'
import { isWorkerType, workerTypeChange } from '../services/workerType.js'

export const peopleRouter = Router()

route(
  peopleRouter,
  { method: 'get', path: '/people', tag: 'People', summary: 'The roster.', access: ['people:read'], query: { active: 'true or false' } },
  async (req) => {
    const auth = requireScope(req, 'people:read')
    const people = await prisma.person.findMany({
      where: { companyId: auth.companyId, active: bool(req.query.active) },
      orderBy: { name: 'asc' },
    })
    return { data: people.map(publicPerson), contractorsEnabled: config.contractorsEnabled }
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
    body: {
      name: 'Display name',
      initials: 'Initials as written on the job calendar',
      role: 'tech | lead | manager | payroll | admin (admin needs a signed-in admin or a key with people:roles)',
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
    if (role !== undefined && !isRole(role)) throw badRequest('role must be tech, lead, manager, payroll or admin.', { field: 'role' })
    // Only a signed-in admin hands out or takes away the admin role.
    if (!mayManageAdmins && (role === 'admin' || (existing?.role === 'admin' && role !== undefined))) {
      throw forbidden('Only a signed-in admin can change who is an admin.')
    }
    const active = bool(req.body?.active)
    if (!mayManageAdmins && existing?.role === 'admin' && active === false) throw forbidden('Only a signed-in admin can deactivate an admin.')

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
            data: { name: name || undefined, initials, role, active, passwordHash, mustChangePassword, ...worker },
          })
        : await tx.person.create({
            data: {
              companyId: auth.companyId,
              email,
              name: name || email,
              initials: initials ?? '',
              role: role ?? 'tech',
              active: active ?? true,
              passwordHash,
              mustChangePassword,
              ...worker,
            },
          })
      await emit(tx, auth.companyId, 'person.upserted', { person: { id: saved.id, email: saved.email, name: saved.name, role: saved.role, active: saved.active, workerType: saved.workerType } })
      return saved
    })
    return { created: !existing, person: publicPerson(person) }
  },
)
