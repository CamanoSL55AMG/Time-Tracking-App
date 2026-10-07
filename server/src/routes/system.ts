import { Router } from 'express'
import { prisma } from '../db.js'
import { limitOf, openApiDocument, optionalDate, registry, requiredStr, route, str } from '../api.js'
import { badRequest, notFound } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { generateKey, isScope, KEYS_MANAGE, SCOPES } from '../auth/apiKeys.js'
import { GROUPS, hoursReport, type Group } from '../services/reports.js'
import { addDays, dayBounds, isYmd, startOfLocalDay } from '../lib/time.js'

export const systemRouter = Router()

route(systemRouter, { method: 'get', path: '/health', tag: 'System', summary: 'Liveness check.', access: 'public' }, async () => {
  await prisma.$queryRaw`SELECT 1`
  return { ok: true, time: new Date() }
})

// ─── Reports ────────────────────────────────────────────────────────────────

route(
  systemRouter,
  {
    method: 'get',
    path: '/reports/hours',
    tag: 'Views',
    summary: 'Hours grouped by any of person, job, phase, day.',
    access: ['reports:read'],
    query: {
      from: 'YYYY-MM-DD (company timezone) or ISO date-time. Defaults to today',
      to: 'YYYY-MM-DD, inclusive, or ISO date-time, exclusive. Defaults to from',
      groupBy: 'Comma-separated: person, job, phase, day. Defaults to person',
      personId: 'Only this person',
      jobId: 'Only this job',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'reports:read')
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const tz = company.timezone
    const fromRaw = str(req.query.from, 40)
    const toRaw = str(req.query.to, 40)
    const today = dayBounds(new Date(), tz)

    const from = !fromRaw ? today.start : isYmd(fromRaw) ? startOfLocalDay(fromRaw, tz) : optionalDate(fromRaw, 'from')!
    let to: Date
    if (!toRaw) to = !fromRaw ? today.end : isYmd(fromRaw) ? startOfLocalDay(addDays(fromRaw, 1), tz) : new Date(from.getTime() + 86_400_000)
    else to = isYmd(toRaw) ? startOfLocalDay(addDays(toRaw, 1), tz) : optionalDate(toRaw, 'to')!

    const groupBy = str(req.query.groupBy, 100)
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean)
    for (const g of groupBy) {
      if (!(GROUPS as readonly string[]).includes(g)) throw badRequest(`groupBy accepts ${GROUPS.join(', ')}.`, { field: 'groupBy' })
    }
    return hoursReport(auth.companyId, {
      from,
      to,
      groupBy: groupBy as Group[],
      personId: str(req.query.personId, 80) || undefined,
      jobId: str(req.query.jobId, 80) || undefined,
    })
  },
)

// ─── Change feed ────────────────────────────────────────────────────────────

route(
  systemRouter,
  {
    method: 'get',
    path: '/events',
    tag: 'Integration',
    summary: 'Ordered change feed. Remember the last seq you processed and pass it as after.',
    access: ['events:read'],
    query: { after: 'Return events with seq greater than this. Defaults to 0', limit: 'Page size, 100 by default, 500 at most' },
  },
  async (req) => {
    const auth = requireScope(req, 'events:read')
    const after = Number(req.query.after ?? 0)
    if (!Number.isInteger(after) || after < 0) throw badRequest('after must be a whole number.', { field: 'after' })
    const limit = limitOf(req.query.limit)
    const rows = await prisma.event.findMany({
      where: { companyId: auth.companyId, seq: { gt: after } },
      orderBy: { seq: 'asc' },
      take: limit + 1,
    })
    const page = rows.slice(0, limit)
    return {
      data: page.map((e) => ({ seq: e.seq, type: e.type, at: e.at, payload: e.payload })),
      lastSeq: page.length ? page[page.length - 1].seq : after,
      more: rows.length > limit,
    }
  },
)

// ─── Integration keys (signed-in admins only) ───────────────────────────────

const keyView = (k: { id: string; name: string; prefix: string; scopes: string[]; createdAt: Date; lastUsedAt: Date | null; revokedAt: Date | null }) => ({
  id: k.id,
  name: k.name,
  prefix: `${k.prefix}…`,
  scopes: k.scopes,
  createdAt: k.createdAt,
  lastUsedAt: k.lastUsedAt,
  revokedAt: k.revokedAt,
})

route(
  systemRouter,
  { method: 'get', path: '/api-keys', tag: 'Integration', summary: 'Integration keys. The key itself is never shown again after creation.', access: [KEYS_MANAGE] },
  async (req) => {
    const auth = requireScope(req, KEYS_MANAGE)
    const keys = await prisma.apiKey.findMany({ where: { companyId: auth.companyId }, orderBy: { createdAt: 'desc' } })
    return { data: keys.map(keyView), availableScopes: SCOPES }
  },
)

route(
  systemRouter,
  {
    method: 'post',
    path: '/api-keys',
    tag: 'Integration',
    summary: 'Create a key for one integration. The response is the only time the key is shown.',
    access: [KEYS_MANAGE],
    status: 201,
    body: { name: 'Which app this key is for, e.g. "GED"', scopes: `Array of: ${SCOPES.join(', ')}` },
  },
  async (req) => {
    const auth = requireScope(req, KEYS_MANAGE)
    const name = requiredStr(req.body?.name, 'name', 100)
    const scopes: unknown[] = Array.isArray(req.body?.scopes) ? req.body.scopes : []
    if (!scopes.length) throw badRequest('Give the key at least one scope.', { field: 'scopes', available: SCOPES })
    for (const s of scopes) if (!isScope(s)) throw badRequest(`Unknown scope "${String(s)}".`, { field: 'scopes', available: SCOPES })
    const { key, prefix, keyHash } = generateKey()
    const row = await prisma.apiKey.create({
      data: { companyId: auth.companyId, name, prefix, keyHash, scopes: [...new Set(scopes as string[])], createdById: auth.person?.id ?? null },
    })
    return { key, apiKey: keyView(row) }
  },
)

route(
  systemRouter,
  { method: 'delete', path: '/api-keys/:id', tag: 'Integration', summary: 'Revoke a key. It stops working at once.', access: [KEYS_MANAGE] },
  async (req) => {
    const auth = requireScope(req, KEYS_MANAGE)
    const key = await prisma.apiKey.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!key) throw notFound('API key')
    const row = await prisma.apiKey.update({ where: { id: key.id }, data: { revokedAt: key.revokedAt ?? new Date() } })
    return { apiKey: keyView(row) }
  },
)

// ─── The API describing itself ──────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

systemRouter.get('/openapi.json', (req, res) => {
  res.json(openApiDocument(`${req.protocol}://${req.get('host')}/api/v1`))
})

// A plain page, no scripts, so it works under a strict content-security policy.
systemRouter.get('/docs', (_req, res) => {
  const tags = [...new Set(registry.map((r) => r.tag))]
  const section = (tag: string) =>
    `<h2>${esc(tag)}</h2>` +
    registry
      .filter((r) => r.tag === tag)
      .map((r) => {
        const list = (title: string, items?: Record<string, string>) =>
          items && Object.keys(items).length
            ? `<h4>${title}</h4><table>${Object.entries(items)
                .map(([k, v]) => `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td></tr>`)
                .join('')}</table>`
            : ''
        const access = r.access === 'public' ? 'No sign-in needed' : r.access.length ? `Needs one of: <code>${r.access.map(esc).join('</code>, <code>')}</code>` : 'Any signed-in caller'
        return `<article><h3><span class="m ${r.method}">${r.method.toUpperCase()}</span> <code>/api/v1${esc(r.path)}</code></h3><p>${esc(r.summary)}</p><p class="a">${access}</p>${list('Query', r.query)}${list('Body', r.body)}</article>`
      })
      .join('')
  res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Time Tracking API</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px;color:#1c2330}h1{margin:0 0 4px}h2{margin:36px 0 8px;border-bottom:1px solid #d8dde6;padding-bottom:4px}article{border:1px solid #d8dde6;border-radius:8px;padding:12px 16px;margin:12px 0}h3{margin:0;font-size:15px}h4{margin:12px 0 4px;font-size:13px;color:#566}table{border-collapse:collapse;width:100%}td{border-top:1px solid #eef0f4;padding:4px 8px 4px 0;vertical-align:top;font-size:14px}td:first-child{white-space:nowrap;width:1%}code{font:13px ui-monospace,Consolas,monospace;background:#f2f4f8;padding:1px 4px;border-radius:4px}.m{display:inline-block;min-width:54px;text-align:center;font:600 12px ui-monospace,monospace;padding:2px 6px;border-radius:4px;color:#fff;background:#566}.get{background:#1f6feb}.post{background:#1a7f37}.put{background:#9a6700}.patch{background:#8250df}.delete{background:#cf222e}.a{color:#566;font-size:13px;margin:4px 0}p{margin:6px 0}</style></head><body>
<h1>Time Tracking API</h1>
<p>Version 1. Machine-readable description: <a href="openapi.json">openapi.json</a></p>
<p>Send <code>Authorization: Bearer &lt;token&gt;</code>: a session token from <code>/auth/login</code>, or an integration key (<code>tt_live_…</code>). An integration acts for a person by adding <code>X-Act-As: person@company.com</code> (needs <code>punch:write:any</code>). POST requests accept an <code>Idempotency-Key</code> header; repeating one returns the first result. Errors are <code>{ "error": { "code", "message", "details" } }</code> with a matching HTTP status. Limits are reported in <code>RateLimit-*</code> headers.</p>
${tags.map(section).join('')}
</body></html>`)
})
