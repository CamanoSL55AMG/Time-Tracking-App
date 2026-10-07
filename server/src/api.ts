import type { Request, RequestHandler, Response, Router } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from './db.js'
import { badRequest } from './errors.js'

// Every endpoint is declared once, through route(). That single declaration both
// mounts the handler and feeds the OpenAPI document, so the published API
// description cannot drift from the code.

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete'

export interface RouteDoc {
  method: Method
  path: string // express style, e.g. /punches/:id
  tag: string
  summary: string
  /** 'public' or the scopes of which the caller needs at least one. */
  access: 'public' | string[]
  query?: Record<string, string>
  body?: Record<string, string>
  status?: number
}

export const registry: RouteDoc[] = []

type Handler = (req: Request, res: Response) => Promise<unknown>

export function route(router: Router, doc: RouteDoc, handler: Handler): void {
  registry.push(doc)
  const wrapped: RequestHandler = (req, res, next) => {
    run(doc, handler, req, res).catch(next)
  }
  router[doc.method](doc.path, wrapped)
}

async function run(doc: RouteDoc, handler: Handler, req: Request, res: Response): Promise<void> {
  const status = doc.status ?? 200
  const idemKey = doc.method === 'post' ? String(req.headers['idempotency-key'] ?? '').trim() : ''
  const companyId = req.auth?.companyId

  if (idemKey && companyId) {
    if (idemKey.length > 200) throw badRequest('Idempotency-Key is too long (200 characters at most).')
    const seen = await prisma.idempotencyKey.findUnique({ where: { companyId_key: { companyId, key: idemKey } } })
    if (seen) {
      res.setHeader('Idempotent-Replay', 'true')
      res.status(seen.status).json(seen.response)
      return
    }
  }

  const result = await handler(req, res)
  if (res.headersSent) return
  const body = toJson(result ?? { ok: true })

  if (idemKey && companyId) {
    // A concurrent duplicate may have stored first; that is fine, both did the same work
    // only if the handler itself is safe to repeat, which the punch endpoints are via clientId.
    await prisma.idempotencyKey
      .createMany({
        data: [{ companyId, key: idemKey, method: doc.method, path: req.path, status, response: body as Prisma.InputJsonValue }],
        skipDuplicates: true,
      })
      .catch(() => undefined)
  }
  res.status(status).json(body)
}

/** Dates become ISO strings; nothing else needs converting. */
const toJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

// ─── Small input helpers ────────────────────────────────────────────────────

export const str = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export function requiredStr(v: unknown, field: string, max = 500): string {
  const s = str(v, max)
  if (!s) throw badRequest(`${field} is required.`, { field })
  return s
}

export function optionalDate(v: unknown, field: string): Date | undefined {
  if (v === undefined || v === null || v === '') return undefined
  const d = new Date(String(v))
  if (Number.isNaN(d.getTime())) throw badRequest(`${field} must be an ISO 8601 date-time.`, { field })
  return d
}

export function limitOf(v: unknown, fallback = 100, max = 500): number {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(max, Math.floor(n))
}

export const bool = (v: unknown): boolean | undefined =>
  v === true || v === 'true' || v === '1' ? true : v === false || v === 'false' || v === '0' ? false : undefined

// ─── OpenAPI ────────────────────────────────────────────────────────────────

export function openApiDocument(serverUrl: string) {
  const paths: Record<string, Record<string, unknown>> = {}
  for (const r of registry) {
    const params = [...r.path.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1])
    const path = r.path.replace(/:([A-Za-z]+)/g, '{$1}')
    const parameters = [
      ...params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string' } })),
      ...Object.entries(r.query ?? {}).map(([name, description]) => ({ name, in: 'query', required: false, description, schema: { type: 'string' } })),
    ]
    const op: Record<string, unknown> = {
      tags: [r.tag],
      summary: r.summary,
      parameters,
      security: r.access === 'public' ? [] : [{ bearer: [] }],
      'x-scopes': r.access === 'public' ? [] : r.access,
      responses: {
        [String(r.status ?? 200)]: { description: 'Success', content: { 'application/json': { schema: { type: 'object' } } } },
        default: { description: 'Error', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
      },
    }
    if (r.body) {
      op.requestBody = {
        content: {
          'application/json': {
            schema: {
              type: 'object',
              properties: Object.fromEntries(Object.entries(r.body).map(([k, description]) => [k, { description }])),
            },
          },
        },
      }
    }
    paths[path] = { ...(paths[path] ?? {}), [r.method]: op }
  }
  return {
    openapi: '3.0.3',
    info: {
      title: 'Time Tracking API',
      version: '1.0.0',
      description:
        'Punches, jobs, people and reports. Authenticate with `Authorization: Bearer <token>`: a session token from /auth/login, or an integration key (tt_live_…). ' +
        'An integration acts for a person with `X-Act-As: <email>`. POST requests accept `Idempotency-Key`. ' +
        'Errors are `{ "error": { "code", "message", "details" } }` with a matching HTTP status.',
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'object',
              properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
              required: ['code', 'message'],
            },
          },
        },
      },
    },
    paths,
  }
}
