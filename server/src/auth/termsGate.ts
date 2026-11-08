import type { NextFunction, Request, Response } from 'express'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { ApiError } from '../errors.js'
import { defaultTermsDir, gateApplies, gateDecision, loadManifest, pendingDocuments, type Accepted, type LoadResult, type Manifest } from '../services/terms.js'

// The first sign-in terms at run time: the manifest (read once), what a person has
// accepted, and the middleware that holds a signed-in person's requests until every
// document is accepted. The decisions themselves live in services/terms.ts.

let loaded: LoadResult | null = null

/** The manifest and documents, read once and kept in memory. A restart re-reads them. */
export function terms(): LoadResult {
  if (!loaded) loaded = loadManifest(config.termsDir || defaultTermsDir())
  return loaded
}

export const termsUnavailable = () => new ApiError(503, 'terms_unavailable', 'The terms could not be loaded, so the app is closed for now. Tell your administrator.')
export const termsRequired = () => new ApiError(403, 'terms_required', 'Accept the terms to continue.')

/** Called once at start: says what was loaded, and loudly when the gate is on and the documents are broken. */
export function logTermsAtStart(): void {
  const t = terms()
  if (!config.termsGateEnabled) {
    if (!t.ok) console.warn(`Terms: ${t.error}. The terms gate is off, so nothing is blocked.`)
    return
  }
  if (t.ok) console.log(`Terms gate ON: ${t.manifest.documents.map((d) => `${d.id}@${d.version}`).join(', ')}`)
  else console.error(`Terms gate ON but the documents cannot be used: ${t.error}. Every signed-in person's request answers 503 terms_unavailable until this is fixed.`)
}

export const acceptedBy = (companyId: string, personId: string): Promise<Accepted[]> =>
  prisma.termsAcceptance.findMany({ where: { companyId, userId: personId }, select: { documentId: true, version: true } })

// How many documents a person still owes, kept for a short while so the gate is not a
// database read on every request. Accepting clears that person's entry.
const CACHE_MS = 30_000
const cache = new Map<string, { pending: number; at: number }>()

export const forgetTermsCache = (personId: string) => {
  cache.delete(personId)
}

async function pendingCount(companyId: string, personId: string, manifest: Manifest): Promise<number> {
  const now = Date.now()
  const hit = cache.get(personId)
  if (hit && now - hit.at < CACHE_MS) return hit.pending
  const pending = pendingDocuments(manifest, await acceptedBy(companyId, personId)).length
  cache.set(personId, { pending, at: now })
  if (cache.size > 5000) for (const [k, v] of cache) if (now - v.at >= CACHE_MS) cache.delete(k)
  return pending
}

/** Runs after authenticate: a signed-in person with documents still to accept can only reach the exempt paths. */
export function termsGate(req: Request, _res: Response, next: NextFunction): void {
  const input = { enabled: config.termsGateEnabled, via: req.auth?.via ?? null, path: req.path }
  if (!gateApplies(input)) return next()
  const t = terms()
  const person = req.auth?.person
  if (!t.ok || !person) {
    next(gateDecision({ ...input, manifestOk: false, pendingCount: 0 }) === 'pass' ? undefined : termsUnavailable())
    return
  }
  pendingCount(req.auth!.companyId, person.id, t.manifest)
    .then((n) => next(gateDecision({ ...input, manifestOk: true, pendingCount: n }) === 'pass' ? undefined : termsRequired()))
    .catch(next)
}
