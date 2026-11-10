import type { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { notFound } from '../errors.js'
import type { Auth } from './middleware.js'

// Division admins (role division_admin, e.g. the Stage Forge admin) see and manage only
// the people whose Person.division matches their own, plus themselves. Everyone else
// sees the whole company and every helper here is a no-op for them.
//
// The limit is enforced on the server, per endpoint: a route that handles other people's
// data declares `division: true` (api.ts) and uses these helpers. A route without the
// flag gives a division admin a tech's scopes only.

/** The division name as stored: trimmed, single spaces, 80 characters at most. */
export const cleanDivision = (v: unknown): string => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, 80) : '')

export const isLimited = (auth: Auth): boolean => auth.division !== null

/** Which people the caller may see, as a Person filter. Unlimited callers: the company. */
export function peopleWhere(auth: Auth): Prisma.PersonWhereInput {
  if (auth.division === null) return { companyId: auth.companyId }
  const self = auth.person?.id ?? ''
  // No division set: nobody but themselves (never "everyone without a division").
  if (!auth.division) return { companyId: auth.companyId, id: self }
  return { companyId: auth.companyId, OR: [{ id: self }, { division: auth.division }] }
}

/** The ids the caller may see, or null when they see the whole company. */
export async function visiblePeople(auth: Auth): Promise<Set<string> | null> {
  if (auth.division === null) return null
  if (!auth.visiblePeople) {
    const rows = await prisma.person.findMany({ where: peopleWhere(auth), select: { id: true } })
    auth.visiblePeople = new Set(rows.map((r) => r.id))
  }
  return auth.visiblePeople
}

/** A Prisma `personId` filter: undefined for the whole company, otherwise `{ in: [...] }`. */
export async function personIdFilter(auth: Auth): Promise<{ in: string[] } | undefined> {
  const ids = await visiblePeople(auth)
  return ids ? { in: [...ids] } : undefined
}

export async function isVisible(auth: Auth, personId: string): Promise<boolean> {
  const ids = await visiblePeople(auth)
  return !ids || ids.has(personId)
}

/** 404 (the same answer as "no such thing") when the person is outside the caller's division. */
export async function assertVisible(auth: Auth, personId: string | null | undefined, what = 'Person'): Promise<void> {
  const ids = await visiblePeople(auth)
  if (ids && (!personId || !ids.has(personId))) throw notFound(what)
}

/** Keep the rows about people the caller may see. */
export async function onlyVisible<T>(auth: Auth, rows: T[], personIdOf: (row: T) => string | null | undefined): Promise<T[]> {
  const ids = await visiblePeople(auth)
  if (!ids) return rows
  return rows.filter((r) => {
    const id = personIdOf(r)
    return Boolean(id && ids.has(id))
  })
}
