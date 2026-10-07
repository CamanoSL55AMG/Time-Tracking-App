import type { NextFunction, Request, Response } from 'express'
import type { Person } from '@prisma/client'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { forbidden, unauthorized, ApiError } from '../errors.js'
import { hashKey, isRole, looksLikeKey, ROLE_SCOPES, SELF } from './apiKeys.js'
import { verifySession } from './session.js'

// Who is calling. A request is either a signed-in person (session token) or an
// integration (API key), optionally acting for a person via X-Act-As.

export interface Auth {
  companyId: string
  via: 'session' | 'key'
  scopes: Set<string>
  /** The person this request is about: the signed-in user, or the X-Act-As target. */
  person: Person | null
  apiKeyId: string | null
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Auth
    }
  }
}

const bearer = (req: Request): string | null => {
  const h = req.headers.authorization
  if (!h) return null
  const m = /^Bearer\s+(.+)$/i.exec(h.trim())
  return m ? m[1].trim() : null
}

async function resolve(req: Request): Promise<Auth | null> {
  const token = bearer(req)
  if (!token) return null

  if (looksLikeKey(token)) {
    const key = await prisma.apiKey.findUnique({ where: { keyHash: hashKey(token) } })
    if (!key || key.revokedAt) throw unauthorized('This API key is not valid or has been revoked.')
    // Best effort; never fail a request because the timestamp could not be written.
    prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined)

    const scopes = new Set<string>(key.scopes)
    let person: Person | null = null
    const actAs = String(req.headers['x-act-as'] ?? '').trim().toLowerCase()
    if (actAs) {
      if (!scopes.has('punch:write:any')) {
        throw forbidden('X-Act-As needs a key with the punch:write:any scope.')
      }
      person = await prisma.person.findFirst({ where: { companyId: key.companyId, email: actAs, active: true } })
      if (!person) throw new ApiError(404, 'act_as_unknown', `No active person with email ${actAs}.`)
      scopes.add(SELF)
    }
    return { companyId: key.companyId, via: 'key', scopes, person, apiKeyId: key.id }
  }

  const claims = verifySession(token)
  if (!claims) throw unauthorized('Your session has expired. Sign in again.')
  const person = await prisma.person.findUnique({ where: { id: claims.sub } })
  if (!person || !person.active || person.companyId !== claims.cid) throw unauthorized('This account is not active.')
  const role = isRole(person.role) ? person.role : 'tech'
  return { companyId: person.companyId, via: 'session', scopes: new Set(ROLE_SCOPES[role]), person, apiKeyId: null }
}

/** Attach req.auth when credentials are present. Does not reject anonymous requests. */
export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  resolve(req)
    .then((auth) => {
      if (auth) req.auth = auth
      next()
    })
    .catch(next)
}

/** The caller, or 401. */
export function requireAuth(req: Request): Auth {
  if (!req.auth) throw unauthorized()
  return req.auth
}

/** The caller must hold at least one of these scopes. */
export function requireScope(req: Request, ...anyOf: string[]): Auth {
  const auth = requireAuth(req)
  if (!anyOf.some((s) => auth.scopes.has(s))) {
    throw forbidden(`This needs one of: ${anyOf.join(', ')}.`, { required: anyOf })
  }
  return auth
}

/** The person the request is about, or a clear error for a key without X-Act-As. */
export function requirePerson(auth: Auth): Person {
  if (!auth.person) {
    throw new ApiError(400, 'no_person', 'This endpoint acts for a person. With an API key, send X-Act-As: <email>.')
  }
  return auth.person
}

// ─── Rate limit ─────────────────────────────────────────────────────────────
// Fixed one-minute window per caller, kept in memory. Enough to stop a runaway
// integration; a shared store replaces it if the app is ever run on several servers.

const windows = new Map<string, { start: number; count: number }>()

export function rateLimit(req: Request, res: Response, next: NextFunction): void {
  const who = req.auth?.apiKeyId ?? req.auth?.person?.id ?? req.ip ?? 'anon'
  const now = Date.now()
  let w = windows.get(who)
  if (!w || now - w.start >= 60_000) {
    w = { start: now, count: 0 }
    windows.set(who, w)
  }
  w.count += 1
  const limit = config.rateLimitPerMinute
  const reset = Math.max(0, Math.ceil((w.start + 60_000 - now) / 1000))
  res.setHeader('RateLimit-Limit', String(limit))
  res.setHeader('RateLimit-Remaining', String(Math.max(0, limit - w.count)))
  res.setHeader('RateLimit-Reset', String(reset))
  if (w.count > limit) {
    res.setHeader('Retry-After', String(reset))
    next(new ApiError(429, 'rate_limited', `Too many requests. Try again in ${reset} seconds.`))
    return
  }
  if (windows.size > 5000) for (const [k, v] of windows) if (now - v.start >= 60_000) windows.delete(k)
  next()
}
