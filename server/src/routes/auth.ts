import { Router } from 'express'
import bcrypt from 'bcryptjs'
import type { Person } from '@prisma/client'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { route, requiredStr, str } from '../api.js'
import { ApiError, badRequest, unauthorized } from '../errors.js'
import { requireAuth, requirePerson } from '../auth/middleware.js'
import { signSession } from '../auth/session.js'
import { verifySsoToken } from '../auth/ssoToken.js'
import { verifyGoogleIdToken } from '../auth/googleIdToken.js'
import { dashboardConfigured, finishSignIn, startUrl } from '../auth/dashboard.js'
import { isRole, ROLE_SCOPES } from '../auth/apiKeys.js'

export const authRouter = Router()

export const publicPerson = (p: Person) => ({
  id: p.id,
  email: p.email,
  name: p.name,
  initials: p.initials,
  role: p.role,
  active: p.active,
  scopes: ROLE_SCOPES[isRole(p.role) ? p.role : 'tech'],
})

const session = (p: Person) => ({ token: signSession({ sub: p.id, cid: p.companyId }), person: publicPerson(p) })

// Slow down password guessing: 10 failures per email+address in 15 minutes.
const failures = new Map<string, { first: number; count: number }>()
const WINDOW_MS = 15 * 60_000
const MAX_FAILURES = 10

function checkLockout(key: string): void {
  const f = failures.get(key)
  if (f && Date.now() - f.first < WINDOW_MS && f.count >= MAX_FAILURES) {
    throw new ApiError(429, 'too_many_attempts', 'Too many failed sign-ins. Wait 15 minutes and try again.')
  }
}
function recordFailure(key: string): void {
  const f = failures.get(key)
  if (!f || Date.now() - f.first >= WINDOW_MS) failures.set(key, { first: Date.now(), count: 1 })
  else f.count += 1
}

route(
  authRouter,
  {
    method: 'post',
    path: '/auth/login',
    tag: 'Sign-in',
    summary: 'Sign in with email and password. Returns a session token.',
    access: 'public',
    body: { email: 'Email address', password: 'Password' },
  },
  async (req) => {
    const email = requiredStr(req.body?.email, 'email', 320).toLowerCase()
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    if (!password) throw badRequest('password is required.', { field: 'password' })
    const key = `${email}|${req.ip}`
    checkLockout(key)
    const person = await prisma.person.findUnique({ where: { email } })
    // Compare against something even when the account is unknown, so timing tells nothing.
    const ok = await bcrypt.compare(password, person?.passwordHash ?? '$2a$10$0000000000000000000000000000000000000000000000000000.')
    if (!person || !person.active || !person.passwordHash || !ok) {
      recordFailure(key)
      throw unauthorized('Email or password is not correct.')
    }
    failures.delete(key)
    return session(person)
  },
)

route(
  authRouter,
  {
    method: 'get',
    path: '/auth/config',
    tag: 'Sign-in',
    summary: 'Which sign-in methods this server offers. The sign-in page reads this.',
    access: 'public',
  },
  async () => ({ googleClientId: config.googleClientId || null, dashboard: dashboardConfigured() }),
)

// ─── Sign in with the Dashboard ─────────────────────────────────────────────
// Browser navigations, not JSON calls: start sends the browser to the Dashboard,
// the Dashboard sends it back to callback, and callback hands the app a session.

// GED roles that map onto ours for someone signing in here for the first time.
const ROLE_FROM_DASHBOARD: Record<string, Person['role']> = { lead: 'lead', technician: 'tech' }

route(
  authRouter,
  {
    method: 'get',
    path: '/auth/dashboard/start',
    tag: 'Sign-in',
    summary: 'Start "Sign in with Dashboard": redirects the browser to the Dashboard sign-in service.',
    access: 'public',
  },
  async (_req, res) => {
    if (!dashboardConfigured()) throw new ApiError(503, 'dashboard_not_configured', 'Signing in with the Dashboard is not set up on this server.')
    try {
      res.redirect(302, await startUrl(res))
    } catch {
      res.redirect(302, `${config.appUrl}/?signin_error=${encodeURIComponent('The Dashboard is not answering. Try again in a minute, or sign in with your password.')}`)
    }
  },
)

route(
  authRouter,
  {
    method: 'get',
    path: '/auth/dashboard/callback',
    tag: 'Sign-in',
    summary: 'Where the Dashboard returns after signing in. Redirects to the app, signed in.',
    access: 'public',
  },
  async (req, res) => {
    const fail = (message: string) => res.redirect(302, `${config.appUrl}/?signin_error=${encodeURIComponent(message)}`)
    let who
    try {
      who = await finishSignIn(req, res)
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'The Dashboard sign-in failed.')
    }
    if (!who.apps.includes(config.ssoAudience)) return fail('Your Dashboard account does not include Time Tracking. Ask your administrator to add it.')

    let person = await prisma.person.findUnique({ where: { email: who.email } })
    if (!person) {
      const companies = await prisma.company.findMany({ take: 2 })
      if (!config.ssoAutoProvision || companies.length !== 1) return fail(`No Time Tracking account exists for ${who.email}. Ask an admin to add you.`)
      person = await prisma.person.create({
        data: { companyId: companies[0].id, email: who.email, name: str(who.name, 200) || who.email, role: ROLE_FROM_DASHBOARD[who.role] ?? 'tech' },
      })
    }
    if (!person.active) return fail('This Time Tracking account is switched off. Ask an admin.')
    // The session token travels in the address fragment, which never reaches a server.
    res.redirect(302, `${config.appUrl}/sso#session=${encodeURIComponent(session(person).token)}`)
  },
)

route(
  authRouter,
  {
    method: 'post',
    path: '/auth/google',
    tag: 'Sign-in',
    summary: 'Sign in with a Google ID token from Google Identity Services. Returns a session token.',
    access: 'public',
    body: { credential: 'The ID token Google returns to the sign-in button' },
  },
  async (req) => {
    if (!config.googleClientId) throw new ApiError(503, 'google_not_configured', 'Google sign-in is not set up on this server (GOOGLE_CLIENT_ID).')
    const credential = requiredStr(req.body?.credential, 'credential', 8000)
    const result = await verifyGoogleIdToken(credential, config.googleClientId).catch((err: unknown) => {
      throw new ApiError(502, 'google_unreachable', err instanceof Error ? err.message : 'Could not reach Google.')
    })
    if (!result.ok) throw unauthorized(result.reason)
    const { email, name, hd } = result.identity

    let person = await prisma.person.findUnique({ where: { email } })
    if (!person) {
      // Only people from the company's own Google Workspace domain are added on first sign-in.
      const domainOk = Boolean(config.googleAllowedDomain) && (hd === config.googleAllowedDomain || email.endsWith(`@${config.googleAllowedDomain}`))
      const companies = domainOk ? await prisma.company.findMany({ take: 2 }) : []
      if (!domainOk || companies.length !== 1) {
        throw unauthorized(`No Time Tracking account exists for ${email}. Ask an admin to add you.`)
      }
      person = await prisma.person.create({ data: { companyId: companies[0].id, email, name: str(name, 200) || email, role: 'tech' } })
    }
    if (!person.active) throw unauthorized('This account is not active.')
    return session(person)
  },
)

route(
  authRouter,
  {
    method: 'post',
    path: '/auth/sso',
    tag: 'Sign-in',
    summary: 'Exchange a one-click sign-in token from GED for a session token.',
    access: 'public',
    body: { token: 'The v1.<payload>.<signature> token issued by GED for audience time_tracking' },
  },
  async (req) => {
    const token = requiredStr(req.body?.token, 'token', 4000)
    const result = verifySsoToken(token, config.addonSsoSecret, config.ssoAudience)
    if (!result.ok) throw unauthorized(result.reason)
    const { email, name, jti, exp } = result.payload

    // Single use: nothing is inserted if this token id was seen before.
    const fresh = await prisma.ssoNonce.createMany({ data: [{ jti }], skipDuplicates: true })
    if (fresh.count === 0) throw unauthorized('This sign-in link has already been used.')
    // Old ids are no longer needed once their tokens have expired.
    prisma.ssoNonce.deleteMany({ where: { usedAt: { lt: new Date((exp - 3600) * 1000) } } }).catch(() => undefined)

    const lower = email.toLowerCase()
    let person = await prisma.person.findUnique({ where: { email: lower } })
    if (!person) {
      if (!config.ssoAutoProvision) throw unauthorized('No Time Tracking account exists for this email.')
      const companies = await prisma.company.findMany({ take: 2 })
      if (companies.length !== 1) throw unauthorized('No Time Tracking account exists for this email.')
      person = await prisma.person.create({
        data: { companyId: companies[0].id, email: lower, name: str(name, 200) || lower, role: 'tech' },
      })
    }
    if (!person.active) throw unauthorized('This account is not active.')
    return session(person)
  },
)

route(
  authRouter,
  { method: 'get', path: '/auth/me', tag: 'Sign-in', summary: 'Who the caller is and what they may do.', access: [] },
  async (req) => {
    const auth = requireAuth(req)
    return {
      via: auth.via,
      scopes: [...auth.scopes],
      person: auth.person ? publicPerson(auth.person) : null,
    }
  },
)

route(
  authRouter,
  {
    method: 'post',
    path: '/auth/password',
    tag: 'Sign-in',
    summary: 'Change your own password.',
    access: ['punch:self'],
    body: { current: 'Current password (omit if none is set yet)', next: 'New password, at least 10 characters' },
  },
  async (req) => {
    const auth = requireAuth(req)
    if (auth.via !== 'session') throw badRequest('Passwords are changed by the person, signed in.')
    const person = requirePerson(auth)
    const next = typeof req.body?.next === 'string' ? req.body.next : ''
    if (next.length < 10) throw badRequest('The new password needs at least 10 characters.', { field: 'next' })
    if (person.passwordHash) {
      const current = typeof req.body?.current === 'string' ? req.body.current : ''
      if (!(await bcrypt.compare(current, person.passwordHash))) throw unauthorized('The current password is not correct.')
    }
    await prisma.person.update({ where: { id: person.id }, data: { passwordHash: await bcrypt.hash(next, 12) } })
    return { ok: true }
  },
)
