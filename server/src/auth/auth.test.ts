import test from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { signSsoToken, verifySsoToken, type SsoPayload } from './ssoToken.js'
import { generateKey, hashKey, isScope, looksLikeKey, ROLE_SCOPES, KEYS_MANAGE, SELF } from './apiKeys.js'

const secret = 'test-secret-test-secret-test-secret'
const now = 1_800_000_000
const payload = (over: Partial<SsoPayload> = {}): SsoPayload => ({
  v: 1,
  aud: 'time_tracking',
  email: 'tech@example.com',
  name: 'Tech',
  iat: now,
  exp: now + 60,
  jti: 'abc123',
  ...over,
})

test('a good token verifies', () => {
  const r = verifySsoToken(signSsoToken(payload(), secret), secret, 'time_tracking', now)
  assert.equal(r.ok, true)
  if (r.ok) assert.equal(r.payload.email, 'tech@example.com')
})

test('matches the format GED issues', () => {
  // Same construction as GED's signAddonToken.
  const body = Buffer.from(JSON.stringify(payload())).toString('base64url')
  const sig = createHmac('sha256', secret).update(`v1.${body}`).digest('base64url')
  assert.equal(verifySsoToken(`v1.${body}.${sig}`, secret, 'time_tracking', now).ok, true)
})

test('rejects wrong secret, audience, expiry, tampering and junk', () => {
  const t = signSsoToken(payload(), secret)
  assert.equal(verifySsoToken(t, 'another-secret', 'time_tracking', now).ok, false)
  assert.equal(verifySsoToken(t, secret, 'av_inventory', now).ok, false)
  assert.equal(verifySsoToken(t, secret, 'time_tracking', now + 61).ok, false)
  assert.equal(verifySsoToken(t, '', 'time_tracking', now).ok, false)
  const [v, body, sig] = t.split('.')
  const forged = Buffer.from(JSON.stringify(payload({ email: 'admin@example.com' }))).toString('base64url')
  assert.equal(verifySsoToken(`${v}.${forged}.${sig}`, secret, 'time_tracking', now).ok, false)
  assert.equal(verifySsoToken(`${v}.${body}.`, secret, 'time_tracking', now).ok, false)
  assert.equal(verifySsoToken('not-a-token', secret, 'time_tracking', now).ok, false)
  assert.equal(verifySsoToken(signSsoToken(payload({ jti: '' }), secret), secret, 'time_tracking', now).ok, false)
})

test('keys are random, recognisable and stored only as a hash', () => {
  const a = generateKey()
  const b = generateKey()
  assert.notEqual(a.key, b.key)
  assert.ok(looksLikeKey(a.key))
  assert.equal(a.keyHash, hashKey(a.key))
  assert.equal(a.keyHash.length, 64)
  assert.ok(!a.keyHash.includes(a.key.slice(8)))
  assert.ok(a.key.startsWith(a.prefix) && a.prefix.length < 20)
  assert.equal(looksLikeKey('eyJhbGciOi'), false)
})

test('roles', () => {
  assert.ok(ROLE_SCOPES.tech.includes(SELF))
  assert.ok(!ROLE_SCOPES.tech.includes('punch:read'))
  assert.ok(!ROLE_SCOPES.manager.includes(KEYS_MANAGE))
  assert.ok(ROLE_SCOPES.admin.includes(KEYS_MANAGE))
  assert.equal(isScope('punch:read'), true)
  assert.equal(isScope(KEYS_MANAGE), false) // never grantable to a key
  assert.equal(isScope(SELF), false)
})
