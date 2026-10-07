import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { prisma } from '../db.js'
import { bool, route, str } from '../api.js'
import { badRequest, conflict, forbidden } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { isRole, KEYS_MANAGE } from '../auth/apiKeys.js'
import { emit } from '../services/events.js'
import { publicPerson } from './auth.js'

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
    return { data: people.map(publicPerson) }
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
      role: 'tech | lead | manager | payroll | admin',
      active: 'false to stop the person signing in or punching',
      password: 'Set an initial password (signed-in admins only)',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'people:write')
    const email = str(req.params.email, 320).toLowerCase()
    if (!email.includes('@')) throw badRequest('That is not an email address.', { field: 'email' })
    const isAdmin = auth.via === 'session' && auth.scopes.has(KEYS_MANAGE)

    const existing = await prisma.person.findUnique({ where: { email } })
    if (existing && existing.companyId !== auth.companyId) throw forbidden('That email belongs to another company.')

    const role = req.body?.role === undefined ? undefined : String(req.body.role)
    if (role !== undefined && !isRole(role)) throw badRequest('role must be tech, lead, manager, payroll or admin.', { field: 'role' })
    // Only a signed-in admin hands out or takes away the admin role.
    if (!isAdmin && (role === 'admin' || (existing?.role === 'admin' && role !== undefined))) {
      throw forbidden('Only a signed-in admin can change who is an admin.')
    }
    const active = bool(req.body?.active)
    if (!isAdmin && existing?.role === 'admin' && active === false) throw forbidden('Only a signed-in admin can deactivate an admin.')

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

    const name = str(req.body?.name, 200)
    const initials = req.body?.initials === undefined ? undefined : str(req.body.initials, 8).toUpperCase()

    const person = await prisma.$transaction(async (tx) => {
      const saved = existing
        ? await tx.person.update({
            where: { id: existing.id },
            data: { name: name || undefined, initials, role, active, passwordHash },
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
            },
          })
      await emit(tx, auth.companyId, 'person.upserted', { person: { id: saved.id, email: saved.email, name: saved.name, role: saved.role, active: saved.active } })
      return saved
    })
    return { created: !existing, person: publicPerson(person) }
  },
)
