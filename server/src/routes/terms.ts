import { Router } from 'express'
import { prisma } from '../db.js'
import { config } from '../config.js'
import { requiredStr, route } from '../api.js'
import { ApiError, conflict, forbidden, notFound } from '../errors.js'
import { requireAuth, requirePerson } from '../auth/middleware.js'
import { acceptedBy, forgetTermsCache, terms, termsUnavailable } from '../auth/termsGate.js'
import { decideAccept, statusOf } from '../services/terms.js'

// First sign-in terms: the app's Privacy Policy, its EULA, then the AIC Platform Terms,
// each accepted on its own. These three endpoints stay open while the gate holds
// everything else (auth/termsGate.ts).

export const termsRouter = Router()

route(
  termsRouter,
  {
    method: 'get',
    path: '/terms/status',
    tag: 'Sign-in',
    summary: 'Which terms documents the signed-in person still has to accept, in order. complete = nothing left (always true while the gate is off).',
    access: [],
  },
  async (req) => {
    const auth = requireAuth(req)
    const person = requirePerson(auth)
    const t = terms()
    if (!t.ok) {
      if (config.termsGateEnabled) throw termsUnavailable()
      return statusOf(false, null, [])
    }
    return statusOf(config.termsGateEnabled, t.manifest, await acceptedBy(auth.companyId, person.id))
  },
)

route(
  termsRouter,
  {
    method: 'get',
    path: '/terms/documents/:id',
    tag: 'Sign-in',
    summary: 'One terms document: title, kind, current version and its Markdown text.',
    access: [],
  },
  async (req) => {
    requireAuth(req)
    const t = terms()
    if (!t.ok) throw termsUnavailable()
    const doc = t.manifest.documents.find((d) => d.id === req.params.id)
    if (!doc) throw notFound('Document')
    return { id: doc.id, title: doc.title, kind: doc.kind, version: doc.version, text: doc.text }
  },
)

route(
  termsRouter,
  {
    method: 'post',
    path: '/terms/accept',
    tag: 'Sign-in',
    summary: 'Accept the next pending terms document. Must be the first pending one at its current version. Returns the new status.',
    access: [],
    body: { documentId: 'The document id, e.g. logbook-eula', version: 'The version that was shown' },
  },
  async (req) => {
    const auth = requireAuth(req)
    // A person accepts for themselves; an integration cannot accept on their behalf.
    if (auth.via !== 'session') throw forbidden('Terms are accepted by the person, signed in.')
    const person = requirePerson(auth)
    const t = terms()
    if (!t.ok) throw termsUnavailable()
    const documentId = requiredStr(req.body?.documentId, 'documentId', 100)
    const version = requiredStr(req.body?.version, 'version', 100)

    const accepted = await acceptedBy(auth.companyId, person.id)
    const decision = decideAccept(t.manifest, accepted, { documentId, version })
    if (decision.action === 'refuse') {
      const status = statusOf(config.termsGateEnabled, t.manifest, accepted)
      if (decision.code === 'terms_unknown_document') throw new ApiError(404, decision.code, decision.message, { status })
      throw conflict(decision.code, decision.message, { status })
    }
    if (decision.action === 'record') {
      const { doc } = decision
      // The unique (userId, documentId, version) makes a double click harmless.
      await prisma.termsAcceptance.createMany({
        data: [
          {
            companyId: auth.companyId,
            userId: person.id,
            documentId: doc.id,
            version: doc.version,
            contentSha256: doc.sha256,
            ip: String(req.ip ?? '').slice(0, 100),
            userAgent: String(req.headers['user-agent'] ?? '').slice(0, 500),
          },
        ],
        skipDuplicates: true,
      })
      forgetTermsCache(person.id)
    }
    return statusOf(config.termsGateEnabled, t.manifest, await acceptedBy(auth.companyId, person.id))
  },
)
