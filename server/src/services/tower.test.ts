import test from 'node:test'
import assert from 'node:assert/strict'
import { applyCheck, askTower, logbookSwitch, OFF_MESSAGE, readSwitch, resetSwitch, switchState, towerHeaders } from './tower.js'

const settings = { url: 'https://tower.example.com/', token: 'aircraft-token' }
const answer = (status: number, body: unknown) => async () => ({ ok: status >= 200 && status < 300, status, json: async () => body })
const quiet = { warn: () => undefined, log: () => undefined }

test('the switch is read from the Tower answer', () => {
  assert.equal(readSwitch({ entitlements: { LOGBOOK: ['core'] } }), true)
  assert.equal(readSwitch({ entitlements: { GED: ['core'] } }), false, 'Logbook missing from the manifest = OFF')
  assert.equal(readSwitch({ entitlements: {} }), false)
  assert.equal(readSwitch({ entitlements: { LOGBOOK: 'core' } }), null)
  assert.equal(readSwitch({ nope: true }), null)
  assert.equal(readSwitch(null), null)
})

test('asks the Tower with the aircraft token', async () => {
  let seen = { url: '', auth: '' }
  const r = await askTower(settings, async (url, init) => {
    seen = { url, auth: init.headers.Authorization }
    return { ok: true, status: 200, json: async () => ({ entitlements: { LOGBOOK: ['core'] } }) }
  })
  assert.equal(seen.url, 'https://tower.example.com/api/agent/entitlements')
  assert.equal(seen.auth, 'Bearer aircraft-token')
  assert.equal(r.on, true)
  assert.equal(r.reason, 'tower')
})

test('OFF in the Tower means OFF', async () => {
  const r = await askTower(settings, answer(200, { entitlements: { GED: ['core'] } }))
  assert.deepEqual([r.on, r.reason], [false, 'tower'])
})

test('fails open: no settings, Tower down, refused token, old Tower, junk answer', async () => {
  assert.deepEqual((await askTower({ url: '', token: '' })).reason, 'not_configured')
  assert.equal((await askTower({ url: '', token: '' })).on, true)
  const down = await askTower(settings, async () => { throw new Error('connect ECONNREFUSED') })
  assert.deepEqual([down.on, down.reason], [true, 'unreachable'])
  assert.match(down.detail ?? '', /ECONNREFUSED/)
  for (const [status, body] of [[401, { message: 'Unknown installation' }], [404, {}], [500, {}], [200, 'not json']] as const) {
    const r = await askTower(settings, answer(status, body))
    assert.deepEqual([r.on, r.reason], [true, 'unreachable'], `status ${status}`)
  }
})

test('warns once when the Tower goes quiet, keeps the last good check time', () => {
  resetSwitch()
  const warnings: string[] = []
  const log = { warn: (m: string) => warnings.push(m), log: () => undefined }
  const at = new Date('2026-11-04T15:00:00Z')
  applyCheck({ on: true, reason: 'tower', checkedAt: at }, log)
  applyCheck({ on: true, reason: 'unreachable', checkedAt: null, detail: 'timeout' }, log)
  applyCheck({ on: true, reason: 'unreachable', checkedAt: null, detail: 'timeout' }, log)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /Leaving Logbook ON/)
  assert.equal(switchState().on, true)
  assert.equal(switchState().checkedAt?.toISOString(), at.toISOString())
  resetSwitch()
})

// ─── Middleware ─────────────────────────────────────────────────────────────

function call(method: string, path: string) {
  const out: { status?: number; body?: unknown; redirect?: string; next: boolean } = { next: false }
  const res = {
    status(s: number) { out.status = s; return this },
    json(b: unknown) { out.body = b; return this },
    redirect(s: number, url: string) { out.status = s; out.redirect = url },
  }
  logbookSwitch({ method, path } as never, res as never, () => { out.next = true })
  return out
}

test('ON lets everything through', () => {
  resetSwitch()
  applyCheck({ on: true, reason: 'tower', checkedAt: new Date() }, quiet)
  assert.equal(call('POST', '/auth/login').next, true)
  assert.equal(call('POST', '/punches').next, true)
  resetSwitch()
})

test('OFF blocks sign-in and the API with a clear message', () => {
  resetSwitch()
  applyCheck({ on: false, reason: 'tower', checkedAt: new Date() }, quiet)
  for (const [m, p] of [['POST', '/auth/login'], ['POST', '/auth/google'], ['POST', '/auth/sso'], ['GET', '/auth/me'], ['POST', '/me/punches'], ['GET', '/payroll/labor']]) {
    const r = call(m, p)
    assert.equal(r.next, false, `${m} ${p}`)
    assert.equal(r.status, 403)
    assert.deepEqual(r.body, { error: { code: 'app_off', message: OFF_MESSAGE } })
  }
  const dash = call('GET', '/auth/dashboard/callback')
  assert.equal(dash.status, 302)
  assert.match(dash.redirect ?? '', /\/\?signin_error=Logbook%20is%20turned%20off/)
  for (const p of ['/health', '/auth/config', '/docs', '/openapi.json']) assert.equal(call('GET', p).next, true, p)
  resetSwitch()
})

test('Tower unreachable after an OFF answer: fails open', () => {
  resetSwitch()
  applyCheck({ on: false, reason: 'tower', checkedAt: new Date() }, quiet)
  applyCheck({ on: true, reason: 'unreachable', checkedAt: null, detail: 'timeout' }, quiet)
  assert.equal(call('POST', '/auth/login').next, true)
  resetSwitch()
})

test('sends the Cloudflare Access service token when set', async () => {
  let headers: Record<string, string> = {}
  let redirect = ''
  await askTower({ ...settings, accessId: 'cf-id', accessSecret: 'cf-secret' }, async (_url, init) => {
    headers = init.headers
    redirect = init.redirect
    return { ok: true, status: 200, json: async () => ({ entitlements: { LOGBOOK: ['core'] } }) }
  })
  assert.equal(headers['CF-Access-Client-Id'], 'cf-id')
  assert.equal(headers['CF-Access-Client-Secret'], 'cf-secret')
  assert.equal(headers.Authorization, 'Bearer aircraft-token')
  assert.equal(redirect, 'manual', 'never follows a redirect to an Access sign-in page')
  assert.equal(towerHeaders(settings)['CF-Access-Client-Id'], undefined, 'no Access headers when not set')
})

test('a redirect from Cloudflare Access fails open and says why', async () => {
  const bare = await askTower(settings, answer(302, null))
  assert.deepEqual([bare.on, bare.reason], [true, 'unreachable'])
  assert.match(bare.detail ?? '', /302.*Cloudflare Access.*set TOWER_ACCESS_ID/)
  const wrong = await askTower({ ...settings, accessId: 'x', accessSecret: 'y' }, answer(302, null))
  assert.match(wrong.detail ?? '', /check TOWER_ACCESS_ID/)
})
