import { createHmac, timingSafeEqual } from 'node:crypto'

// One-click sign-in token shared with GED and the other add-ons:
//   v1.<base64url(json)>.<base64url(hmac-sha256("v1.<body>", ADDON_SSO_SECRET))>
// Payload: { v, aud, email, name, iat, exp, jti }. Lives 60 seconds, single use.

export interface SsoPayload {
  v: number
  aud: string
  email: string
  name?: string
  iat: number
  exp: number
  jti: string
}

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url')

export function signSsoToken(payload: SsoPayload, secret: string): string {
  const body = b64url(JSON.stringify(payload))
  const sig = createHmac('sha256', secret).update(`v1.${body}`).digest('base64url')
  return `v1.${body}.${sig}`
}

export type SsoResult = { ok: true; payload: SsoPayload } | { ok: false; reason: string }

export function verifySsoToken(token: string, secret: string, audience: string, nowSec = Math.floor(Date.now() / 1000)): SsoResult {
  if (!secret) return { ok: false, reason: 'One-click sign-in is not configured on this server.' }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return { ok: false, reason: 'Unrecognised token format.' }
  const [, body, sig] = parts
  const expected = createHmac('sha256', secret).update(`v1.${body}`).digest()
  let given: Buffer
  try {
    given = Buffer.from(sig, 'base64url')
  } catch {
    return { ok: false, reason: 'Bad signature.' }
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'Bad signature.' }
  let payload: SsoPayload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, reason: 'Unreadable token.' }
  }
  if (payload.aud !== audience) return { ok: false, reason: 'Token is for a different app.' }
  if (typeof payload.exp !== 'number' || payload.exp < nowSec) return { ok: false, reason: 'Token has expired.' }
  if (typeof payload.iat === 'number' && payload.iat > nowSec + 60) return { ok: false, reason: 'Token is dated in the future.' }
  if (typeof payload.email !== 'string' || !payload.email.includes('@')) return { ok: false, reason: 'Token names no user.' }
  if (typeof payload.jti !== 'string' || !payload.jti) return { ok: false, reason: 'Token has no id.' }
  return { ok: true, payload }
}
