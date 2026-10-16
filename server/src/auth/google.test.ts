import test from 'node:test'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import { verifyGoogleJwt } from './googleIdToken.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const clientId = 'test-client.apps.googleusercontent.com'
const now = 1_800_000_000
const getKey = async (kid: string) => (kid === 'k1' ? publicKey : null)

const sign = (claims: Record<string, unknown>, header: Record<string, unknown> = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) => {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url')
  const c = Buffer.from(JSON.stringify(claims)).toString('base64url')
  const s = createSign('RSA-SHA256').update(`${h}.${c}`).sign(privateKey).toString('base64url')
  return `${h}.${c}.${s}`
}
const claims = (over: Record<string, unknown> = {}) => ({
  iss: 'https://accounts.google.com',
  aud: clientId,
  sub: '1234',
  email: 'Tech@Example.com',
  email_verified: true,
  name: 'Tech',
  hd: 'example.com',
  iat: now,
  exp: now + 3600,
  ...over,
})

test('a good Google token verifies and the email is lower-cased', async () => {
  const r = await verifyGoogleJwt(sign(claims()), clientId, getKey, now)
  assert.equal(r.ok, true)
  if (r.ok) {
    assert.equal(r.identity.email, 'tech@example.com')
    assert.equal(r.identity.hd, 'example.com')
  }
})

test('rejects wrong audience, issuer, expiry, unverified email, unknown key and tampering', async () => {
  const bad = async (t: string) => assert.equal((await verifyGoogleJwt(t, clientId, getKey, now)).ok, false)
  await bad(sign(claims({ aud: 'someone-else' })))
  await bad(sign(claims({ iss: 'https://evil.example' })))
  await bad(sign(claims({ exp: now - 120 })))
  await bad(sign(claims({ email_verified: false })))
  await bad(sign(claims(), { alg: 'RS256', kid: 'other' }))
  await bad(sign(claims(), { alg: 'HS256', kid: 'k1' }))
  const [h, , s] = sign(claims()).split('.')
  const forged = Buffer.from(JSON.stringify(claims({ email: 'admin@example.com' }))).toString('base64url')
  await bad(`${h}.${forged}.${s}`)
  await bad('not-a-token')
  assert.equal((await verifyGoogleJwt(sign(claims()), '', getKey, now)).ok, false)
})
