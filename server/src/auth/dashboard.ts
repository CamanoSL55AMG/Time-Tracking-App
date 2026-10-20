import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Request, Response } from 'express'
import * as oidc from 'openid-client'
import { config } from '../config.js'

// ─── Sign in with the Dashboard (OpenID Connect client) ─────────────────────
// The Dashboard (GED) is the sign-in service for every add-on. This side starts
// the sign-in, checks what comes back and says who the person is. The routes that
// use it are in routes/auth.ts. Plan: GED's DASHBOARD-SIGN-IN.md.

export const dashboardConfigured = (): boolean => Boolean(config.dashboardIssuer && config.dashboardClientId && config.dashboardClientSecret)

export const CALLBACK_PATH = '/api/v1/auth/dashboard/callback'
const COOKIE = 'tt_dashboard_signin'
const COOKIE_PATH = '/api/v1/auth/dashboard'
const COOKIE_MAX_AGE_S = 600

export const callbackUrl = () => `${config.appUrl}${CALLBACK_PATH}`

let discovered: { at: number; conf: oidc.Configuration } | null = null
/** The Dashboard's sign-in service settings, fetched once an hour. */
async function serviceConfig(): Promise<oidc.Configuration> {
  if (discovered && Date.now() - discovered.at < 3600_000) return discovered.conf
  const issuer = new URL(config.dashboardIssuer)
  const conf = await oidc.discovery(
    issuer,
    config.dashboardClientId,
    undefined,
    oidc.ClientSecretPost(config.dashboardClientSecret),
    issuer.protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined,
  )
  discovered = { at: Date.now(), conf }
  return conf
}

// The PKCE verifier, state and nonce ride in a short-lived signed cookie between
// the start of the sign-in and its return.
const sign = (v: string) => createHmac('sha256', `dashboard-signin:${config.jwtSecret}`).update(v).digest('base64url')

function setStateCookie(res: Response, value: object) {
  const body = Buffer.from(JSON.stringify(value)).toString('base64url')
  const secure = config.appUrl.startsWith('https:') ? '; Secure' : ''
  res.setHeader('Set-Cookie', `${COOKIE}=${body}.${sign(body)}; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=${COOKIE_MAX_AGE_S}${secure}`)
}

function readStateCookie(req: Request): { verifier: string; state: string; nonce: string } | null {
  const raw = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${COOKIE}=`))
  if (!raw) return null
  const [body, mac] = raw.slice(COOKIE.length + 1).split('.')
  if (!body || !mac) return null
  const want = Buffer.from(sign(body))
  const got = Buffer.from(mac)
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }
}

const clearStateCookie = (res: Response) => res.append('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=${COOKIE_PATH}; Max-Age=0`)

/** Where to send the browser to sign in with the Dashboard. */
export async function startUrl(res: Response): Promise<string> {
  const conf = await serviceConfig()
  const verifier = oidc.randomPKCECodeVerifier()
  const state = oidc.randomState()
  const nonce = oidc.randomNonce()
  setStateCookie(res, { verifier, state, nonce })
  const url = oidc.buildAuthorizationUrl(conf, {
    redirect_uri: callbackUrl(),
    scope: 'openid email profile ged',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  })
  return url.href
}

export interface DashboardIdentity {
  email: string
  name: string
  role: string
  apps: string[]
  orgId: string
}

/** Check the Dashboard's answer and say who signed in. Throws with a sentence a person can act on. */
export async function finishSignIn(req: Request, res: Response): Promise<DashboardIdentity> {
  const saved = readStateCookie(req)
  clearStateCookie(res)
  const current = new URL(req.originalUrl, config.appUrl)
  const err = current.searchParams.get('error')
  if (err) throw new Error(current.searchParams.get('error_description') || (err === 'access_denied' ? 'The Dashboard did not allow this sign-in.' : `The Dashboard sign-in failed (${err}).`))
  if (!saved) throw new Error('This sign-in took too long or was started in another browser. Try again.')
  const conf = await serviceConfig()
  const tokens = await oidc.authorizationCodeGrant(conf, current, {
    pkceCodeVerifier: saved.verifier,
    expectedState: saved.state,
    expectedNonce: saved.nonce,
    idTokenExpected: true,
  })
  const c = tokens.claims()
  const email = typeof c?.email === 'string' ? c.email.trim().toLowerCase() : ''
  if (!c || !email) throw new Error('The Dashboard did not say who signed in.')
  return {
    email,
    name: typeof c.name === 'string' ? c.name : '',
    role: typeof c.role === 'string' ? c.role : '',
    apps: Array.isArray(c.apps) ? c.apps.filter((a): a is string => typeof a === 'string') : [],
    orgId: typeof c.org_id === 'string' ? c.org_id : '',
  }
}
