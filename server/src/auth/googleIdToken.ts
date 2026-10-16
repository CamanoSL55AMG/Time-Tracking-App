import { createPublicKey, createVerify, type JsonWebKey, type KeyObject } from 'node:crypto'

// "Sign in with Google": the browser gets an ID token (a JWT signed by Google) from
// Google Identity Services and posts it to /auth/google. We check it here with
// Node's own crypto against Google's published keys, so no extra package is needed:
// RS256 signature, issuer, audience (our OAuth client id), expiry, verified email.

export interface GoogleIdentity {
  sub: string
  email: string
  name: string
  /** Google Workspace domain of the account, empty for a personal Gmail account. */
  hd: string
}

export type GoogleResult = { ok: true; identity: GoogleIdentity } | { ok: false; reason: string }

type KeyLookup = (kid: string) => Promise<KeyObject | null>

const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com'])
const SKEW_SEC = 60

const decodePart = (part: string): any => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))

/** Pure check, with the key lookup passed in so it can be tested without Google. */
export async function verifyGoogleJwt(token: string, clientId: string, getKey: KeyLookup, nowSec = Math.floor(Date.now() / 1000)): Promise<GoogleResult> {
  if (!clientId) return { ok: false, reason: 'Google sign-in is not set up on this server.' }
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) return { ok: false, reason: 'That is not a Google sign-in token.' }
  let header: any
  let claims: any
  try {
    header = decodePart(parts[0])
    claims = decodePart(parts[1])
  } catch {
    return { ok: false, reason: 'That is not a Google sign-in token.' }
  }
  if (header?.alg !== 'RS256' || typeof header?.kid !== 'string') return { ok: false, reason: 'Unexpected Google token format.' }

  const key = await getKey(header.kid)
  if (!key) return { ok: false, reason: 'Google token signed with an unknown key.' }
  const verifier = createVerify('RSA-SHA256')
  verifier.update(`${parts[0]}.${parts[1]}`)
  if (!verifier.verify(key, Buffer.from(parts[2], 'base64url'))) return { ok: false, reason: 'Google token signature is not valid.' }

  if (!ISSUERS.has(claims?.iss)) return { ok: false, reason: 'Google token has the wrong issuer.' }
  const aud = Array.isArray(claims?.aud) ? claims.aud : [claims?.aud]
  if (!aud.includes(clientId)) return { ok: false, reason: 'Google token was issued for a different app.' }
  if (typeof claims?.exp !== 'number' || claims.exp + SKEW_SEC < nowSec) return { ok: false, reason: 'Google sign-in expired. Try again.' }
  if (typeof claims?.iat === 'number' && claims.iat - SKEW_SEC > nowSec) return { ok: false, reason: 'Google token is not valid yet.' }
  const email = String(claims?.email ?? '').trim().toLowerCase()
  if (!email || claims?.email_verified !== true) return { ok: false, reason: 'Google account has no verified email.' }

  return { ok: true, identity: { sub: String(claims.sub ?? ''), email, name: String(claims.name ?? '').trim(), hd: String(claims.hd ?? '').toLowerCase() } }
}

// ── Google's public keys, cached as long as Google says they may be ─────────
const CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
let cache: { until: number; keys: Map<string, KeyObject> } | null = null

async function loadKeys(): Promise<Map<string, KeyObject>> {
  if (cache && Date.now() < cache.until) return cache.keys
  const res = await fetch(CERTS_URL, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Could not fetch Google's signing keys (${res.status}).`)
  const body = (await res.json()) as { keys?: (JsonWebKey & { kid?: string })[] }
  const keys = new Map<string, KeyObject>()
  for (const jwk of body.keys ?? []) if (jwk.kid) keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }))
  const maxAge = Number(/max-age=(\d+)/.exec(res.headers.get('cache-control') ?? '')?.[1] ?? 3600)
  cache = { until: Date.now() + Math.min(Math.max(maxAge, 60), 86_400) * 1000, keys }
  return keys
}

const googleKey: KeyLookup = async (kid) => {
  let keys = await loadKeys()
  if (!keys.has(kid)) {
    // Google rotates keys; refetch once before giving up.
    cache = null
    keys = await loadKeys()
  }
  return keys.get(kid) ?? null
}

export const verifyGoogleIdToken = (token: string, clientId: string) => verifyGoogleJwt(token, clientId, googleKey)
