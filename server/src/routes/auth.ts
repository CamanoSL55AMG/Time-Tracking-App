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
import { OFF_MESSAGE, switchState } from '../services/tower.js'
import { mailerConfigured, sendMail } from '../lib/mailer.js'
import { FORGOT_SENT, MIN_PASSWORD_LENGTH, RESET_LINK_BAD, requestPasswordReset, resetPassword, type ResetStore } from '../auth/passwordReset.js'

export const authRouter = Router()

export const publicPerson = (p: Person) => ({
  id: p.id,
  email: p.email,
  name: p.name,
  initials: p.initials,
  role: p.role,
  active: p.active,
  mustChangePassword: p.mustChangePassword,
  workerType: p.workerType,
  workerTypeFrom: p.workerTypeFrom,
  scopes: ROLE_SCOPES[isRole(p.role) ? p.role : 'tech'],
})

const session = (p: Person) => ({ token: signSession({ sub: p.id, cid: p.companyId }), person: publicPerson(p) })

// Slow down password guessing: 10 failures per email+address in 15 minutes.
const failures = new Map<string, { first: number; count: number }>()
const WINDOW_MS = 15 * 60_000
const MAX_FAILURES = 10

function checkLockout(key: string, message = 'Too many failed sign-ins. Wait 15 minutes and try again.'): void {
  const f = failures.get(key)
  if (f && Date.now() - f.first < WINDOW_MS && f.count >= MAX_FAILURES) {
    throw new ApiError(429, 'too_many_attempts', message)
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

// ─── Forgot password ────────────────────────────────────────────────────────
// The sign-in page's "Forgot password?" emails a one-time link (auth/passwordReset.ts).
// The answer is the same whether or not the address has an account, and the lookup,
// token and email happen after it has gone, so neither words nor timing tell.

const resetStore: ResetStore = {
  findByEmail: (email) => prisma.person.findUnique({ where: { email } }),
  findByTokenHash: (tokenHash) => prisma.person.findUnique({ where: { resetTokenHash: tokenHash } }),
  saveToken: async (id, tokenHash, resetExpiresAt, resetSentAt) => {
    await prisma.person.update({ where: { id }, data: { resetTokenHash: tokenHash, resetExpiresAt, resetSentAt } })
  },
  consume: async (id, tokenHash, now, passwordHash) => {
    // One conditional update: a second use of the same link (even at the same moment) changes nothing.
    const r = await prisma.person.updateMany({
      where: { id, resetTokenHash: tokenHash, resetExpiresAt: { gt: now }, active: true },
      data: { passwordHash, mustChangePassword: false, resetTokenHash: null, resetExpiresAt: null },
    })
    return r.count === 1
  },
  clearToken: async (id) => {
    await prisma.person.update({ where: { id }, data: { resetTokenHash: null, resetExpiresAt: null } })
  },
}

/** Where the emailed link points: APP_URL when it is set, else the address this request came in on. */
// The emailed link must point at this app's own public address. Building it from
// the request's Host header would let a forged header aim the link at another
// site, so in production only APP_URL is used; without it no reset email goes out.
function resetOrigin(): string {
  if (config.appUrlConfigured) return config.appUrlConfigured
  return config.isProduction ? '' : config.appUrl
}

const TOO_MANY_RESETS = 'Too many requests from this device. Wait 15 minutes and try again.'

route(
  authRouter,
  {
    method: 'post',
    path: '/auth/forgot-password',
    tag: 'Sign-in',
    summary: 'Email a one-time link to choose a new password. Always gives the same answer, whether or not the email has an account.',
    access: 'public',
    body: { email: 'Email address' },
  },
  async (req, res) => {
    const email = requiredStr(req.body?.email, 'email', 320).toLowerCase()
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw badRequest('Enter your email address.', { field: 'email' })
    // The sign-in throttle, per device: every ask counts, whatever the email.
    const key = `forgot|${req.ip}`
    checkLockout(key, TOO_MANY_RESETS)
    recordFailure(key)
    const origin = resetOrigin()
    res.status(200).json({ ok: true, message: FORGOT_SENT })
    // After the answer has gone: look up, make the token, send.
    setImmediate(() => {
      if (!origin) {
        console.warn('[auth] forgot-password: APP_URL is not set, so no reset link was emailed')
        return
      }
      requestPasswordReset({ store: resetStore, mailerConfigured, send: (mail) => sendMail(mail) }, email, origin).catch((err: unknown) =>
        console.error('[auth] forgot-password email failed:', err instanceof Error ? err.message : err),
      )
    })
  },
)

route(
  authRouter,
  {
    method: 'post',
    path: '/auth/reset-password',
    tag: 'Sign-in',
    summary: 'Choose a new password with the one-time link from "Forgot password?". The link then stops working.',
    access: 'public',
    body: { token: 'The token from the emailed link', password: `New password, at least ${MIN_PASSWORD_LENGTH} characters` },
  },
  async (req) => {
    const token = requiredStr(req.body?.token, 'token', 200)
    const password = typeof req.body?.password === 'string' ? req.body.password : ''
    const key = `reset|${req.ip}`
    checkLockout(key, TOO_MANY_RESETS)
    const result = await resetPassword({ store: resetStore, hashPassword: (pw) => bcrypt.hash(pw, 12) }, token, password)
    if (!result.ok) {
      if (result.reason === 'weak_password') throw badRequest(`The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`, { field: 'password' })
      recordFailure(key)
      throw new ApiError(400, 'reset_link_invalid', RESET_LINK_BAD)
    }
    return { ok: true }
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
  async () => ({
    googleClientId: config.googleClientId || null,
    dashboard: dashboardConfigured(),
    // Set while AIC Control Tower has Logbook switched OFF; the sign-in page shows it.
    switchedOff: switchState().on ? null : OFF_MESSAGE,
    // Optional parts that are switched on here; the app shows their screens only then.
    features: { leave: config.leaveEnabled, selfEdit: config.selfEditEnabled },
  }),
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
    summary: 'Change your own password. Also clears "must change password" after an admin set it.',
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
      if (await bcrypt.compare(next, person.passwordHash)) {
        throw badRequest('Pick a new password, not the one you have now.', { field: 'next' })
      }
    }
    await prisma.person.update({ where: { id: person.id }, data: { passwordHash: await bcrypt.hash(next, 12), mustChangePassword: false } })
    return { ok: true }
  },
)
