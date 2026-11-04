import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// First sign-in terms. Everything here is pure (no database), so it is unit-tested:
// reading and checking legal/manifest.json, working out what a person still has to
// accept, deciding an accept request, and deciding whether the gate lets a request by.

export type TermsKind = 'privacy' | 'eula' | 'global'
const KINDS: readonly TermsKind[] = ['privacy', 'eula', 'global']

export interface TermsDoc {
  id: string
  title: string
  kind: TermsKind
  version: string
  file: string
  /** The Markdown text, exactly as on disk. */
  text: string
  /** sha256 hex of the file bytes. */
  sha256: string
}
export interface Manifest {
  app: string
  documents: TermsDoc[]
}
export type LoadResult = { ok: true; manifest: Manifest } | { ok: false; error: string }

/** An acceptance row, as far as the logic cares. */
export interface Accepted {
  documentId: string
  version: string
}

/** <repo>/legal, from server/src/services (tsx) or server/dist/services (built). */
export const defaultTermsDir = (): string => path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'legal')

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== ''

/** Read and check the manifest and every document it names. Never throws. */
export function loadManifest(dir: string): LoadResult {
  const fail = (error: string): LoadResult => ({ ok: false, error: `${error} (terms folder: ${dir})` })
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch (err) {
    return fail(`manifest.json could not be read: ${err instanceof Error ? err.message : String(err)}`)
  }
  const m = raw as { app?: unknown; documents?: unknown }
  if (!m || typeof m !== 'object' || !Array.isArray(m.documents) || m.documents.length === 0) return fail('manifest.json needs a non-empty "documents" list')

  const docs: TermsDoc[] = []
  const seen = new Set<string>()
  for (const [i, entry] of (m.documents as unknown[]).entries()) {
    const d = (entry ?? {}) as Record<string, unknown>
    const where = `documents[${i}]`
    if (!nonEmpty(d.id) || !/^[a-z0-9][a-z0-9-]*$/.test(d.id)) return fail(`${where}.id must be lowercase letters, digits and dashes`)
    if (seen.has(d.id)) return fail(`duplicate document id "${d.id}"`)
    seen.add(d.id)
    if (!nonEmpty(d.title)) return fail(`${where} (${d.id}) has no title`)
    if (typeof d.kind !== 'string' || !(KINDS as readonly string[]).includes(d.kind)) return fail(`${where} (${d.id}) kind must be one of ${KINDS.join(', ')}`)
    if (!nonEmpty(d.version)) return fail(`${where} (${d.id}) has no version`)
    if (!nonEmpty(d.file) || path.basename(d.file) !== d.file) return fail(`${where} (${d.id}) file must be a plain file name in the terms folder`)
    let bytes: Buffer
    try {
      bytes = fs.readFileSync(path.join(dir, d.file))
    } catch {
      return fail(`${where} (${d.id}) file ${d.file} is missing`)
    }
    const text = bytes.toString('utf8')
    if (text.trim() === '') return fail(`${where} (${d.id}) file ${d.file} is empty`)
    docs.push({
      id: d.id,
      title: d.title.trim(),
      kind: d.kind as TermsKind,
      version: d.version.trim(),
      file: d.file,
      text,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    })
  }
  const globals = docs.filter((d) => d.kind === 'global')
  if (globals.length !== 1) return fail(`exactly one document must have kind "global" (found ${globals.length})`)
  if (docs[docs.length - 1].kind !== 'global') return fail('the global document must be the last one')
  return { ok: true, manifest: { app: nonEmpty(m.app) ? m.app.trim() : '', documents: docs } }
}

/** Documents, in manifest order, with no acceptance of their current version. Older versions do not count. */
export function pendingDocuments(manifest: Manifest, accepted: Accepted[]): TermsDoc[] {
  const have = new Set(accepted.map((a) => `${a.documentId}\u0000${a.version}`))
  return manifest.documents.filter((d) => !have.has(`${d.id}\u0000${d.version}`))
}

const brief = (d: TermsDoc) => ({ id: d.id, title: d.title, kind: d.kind, version: d.version })

export interface TermsStatus {
  enabled: boolean
  complete: boolean
  pending: { id: string; title: string; kind: TermsKind; version: string }[]
  documents: { id: string; title: string; kind: TermsKind; version: string; accepted: boolean }[]
}

/** What GET /terms/status answers. With the gate off, nothing is pending. */
export function statusOf(enabled: boolean, manifest: Manifest | null, accepted: Accepted[]): TermsStatus {
  if (!manifest) return { enabled, complete: !enabled, pending: [], documents: [] }
  const pending = pendingDocuments(manifest, accepted)
  const open = new Set(pending.map((d) => d.id))
  return {
    enabled,
    complete: !enabled || pending.length === 0,
    pending: enabled ? pending.map(brief) : [],
    documents: manifest.documents.map((d) => ({ ...brief(d), accepted: !open.has(d.id) })),
  }
}

export type AcceptDecision =
  | { action: 'record'; doc: TermsDoc }
  | { action: 'noop'; doc: TermsDoc }
  | { action: 'refuse'; code: 'terms_unknown_document' | 'terms_version_changed' | 'terms_out_of_order'; message: string }

/**
 * An accept request must name the first document still pending, at its current
 * version. Accepting the current version of one already accepted does nothing.
 */
export function decideAccept(manifest: Manifest, accepted: Accepted[], body: { documentId: string; version: string }): AcceptDecision {
  const doc = manifest.documents.find((d) => d.id === body.documentId)
  if (!doc) return { action: 'refuse', code: 'terms_unknown_document', message: `There is no document "${body.documentId}".` }
  if (doc.version !== body.version) {
    return { action: 'refuse', code: 'terms_version_changed', message: `${doc.title} has changed since it was shown. Read the current version and accept it.` }
  }
  const pending = pendingDocuments(manifest, accepted)
  if (!pending.some((d) => d.id === doc.id)) return { action: 'noop', doc }
  if (pending[0].id !== doc.id) {
    return { action: 'refuse', code: 'terms_out_of_order', message: `Accept ${pending[0].title} first.` }
  }
  return { action: 'record', doc }
}

// ─── The gate ───────────────────────────────────────────────────────────────

// Paths under /api/v1 a signed-in person may use before accepting: signing in, who am I,
// the terms themselves, and what is public anyway. Signing out needs no call (the app
// drops its session token).
const EXEMPT = new Set([
  '/health',
  '/openapi.json',
  '/docs',
  '/auth/login',
  '/auth/config',
  '/auth/dashboard/start',
  '/auth/dashboard/callback',
  '/auth/google',
  '/auth/sso',
  '/auth/me',
  '/terms/status',
  '/terms/accept',
])

/** Express matches routes ignoring case and a trailing slash, so the check does too. */
export function isExemptPath(p: string): boolean {
  const n = p.toLowerCase().replace(/\/+$/, '') || '/'
  return EXEMPT.has(n) || /^\/terms\/documents\/[^/]+$/.test(n)
}

export interface GateInput {
  enabled: boolean
  /** How the caller signed in; null for an anonymous request. */
  via: 'session' | 'key' | null
  /** Path inside /api/v1. */
  path: string
}

/** Whether this request has to be checked at all. Only a signed-in person's session is ever held. */
export const gateApplies = (i: GateInput): boolean => i.enabled && i.via === 'session' && !isExemptPath(i.path)

export type GateVerdict = 'pass' | 'terms_required' | 'terms_unavailable'

/** The whole decision. pendingCount is only looked at when the gate applies. */
export function gateDecision(i: GateInput & { manifestOk: boolean; pendingCount: number }): GateVerdict {
  if (!gateApplies(i)) return 'pass'
  if (!i.manifestOk) return 'terms_unavailable'
  return i.pendingCount > 0 ? 'terms_required' : 'pass'
}
