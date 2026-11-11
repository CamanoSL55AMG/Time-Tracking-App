import type { Request } from 'express'
import { prisma } from '../db.js'
import { ApiError, notFound } from '../errors.js'
import type { Auth } from './middleware.js'
import { SELF } from './apiKeys.js'

// Division admins (Art, 2026-11-11): a person with the division_admin role runs the
// admin screens (timecards, missed-punch fixes, leave, reports) for the people in
// their own division only, e.g. Kris for Sound Services. The limit is enforced here,
// on the server, for every query and action; the screens only follow it.
//
// Fail closed: a division admin may call a route only when its declaration says it
// was reviewed for divisions (`division: 'scoped'` in route()), or when it can only
// ever touch the caller (public, no scope, or the caller's own punch:self routes).
// Any route added later is refused to division admins until someone scopes it.

/** "  sound   services " and "Sound Services" are the same division. */
export const normalizeDivision = (v: unknown): string =>
  typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 80) : ''

/** True when the caller is limited to one division. An empty division still limits (to nobody). */
export const isDivisionScoped = (auth: Pick<Auth, 'division'> | undefined): boolean =>
  auth !== undefined && auth.division !== null

/** May a division admin call a route with this declaration at all? */
export function divisionMayCall(doc: { access: 'public' | string[]; division?: 'scoped' }): boolean {
  if (doc.division === 'scoped') return true
  if (doc.access === 'public') return true
  return doc.access.every((s) => s === SELF)
}

/** Throws unless the caller may use this route (does nothing for everyone but division admins). */
export function assertDivisionRoute(req: Request, doc: { method: string; path: string; access: 'public' | string[]; division?: 'scoped' }): void {
  if (!isDivisionScoped(req.auth)) return
  if (!divisionMayCall(doc)) {
    throw new ApiError(403, 'division_not_allowed', 'Division admins cannot use this. Ask a full admin.', { division: req.auth!.division })
  }
}

// Division members are read once per request and kept on the auth object.
const memo = new WeakMap<Auth, Promise<string[]>>()

/** Everyone in the caller's division (active or not, so past weeks still show), or null for no limit. */
export async function divisionPersonIds(auth: Auth): Promise<string[] | null> {
  if (!isDivisionScoped(auth)) return null
  let ids = memo.get(auth)
  if (!ids) {
    const division = auth.division as string
    ids = division
      ? prisma.person
          .findMany({ where: { companyId: auth.companyId, division: { equals: division, mode: 'insensitive' } }, select: { id: true } })
          .then((rows) => rows.map((r) => r.id))
      : Promise.resolve([])
    memo.set(auth, ids)
  }
  return ids
}

/** A personId filter for Prisma: one person, or one of several. */
export type PersonFilter = string | { in: string[] }

/**
 * The person filter for a list endpoint. Everyone else: the requested person, or
 * no filter. A division admin: the requested person if they are in the division
 * (anyone else is refused), otherwise everyone in the division.
 */
export async function personFilterFor(auth: Auth, requested?: string): Promise<PersonFilter | undefined> {
  const ids = await divisionPersonIds(auth)
  return scopePersonFilter(ids, requested)
}

/** The pure part of personFilterFor, tested on its own. */
export function scopePersonFilter(ids: string[] | null, requested?: string): PersonFilter | undefined {
  if (ids === null) return requested || undefined
  if (requested) {
    if (!ids.includes(requested)) throw outsideDivision()
    return requested
  }
  return { in: ids }
}

/** Throws unless every one of these people is in the caller's division. */
export async function assertInDivision(auth: Auth, ...personIds: string[]): Promise<void> {
  const ids = await divisionPersonIds(auth)
  if (ids === null) return
  if (personIds.some((id) => !ids.includes(id))) throw outsideDivision()
}

/** For list endpoints that have no filter of their own: keep only rows in the division. */
export async function keepInDivision<T>(auth: Auth, rows: T[], personIdOf: (row: T) => string): Promise<T[]> {
  const ids = await divisionPersonIds(auth)
  if (ids === null) return rows
  const set = new Set(ids)
  return rows.filter((r) => set.has(personIdOf(r)))
}

// Not 403: a division admin should not learn who exists outside their division.
const outsideDivision = () => notFound('Person')
