import type { NextFunction, Request, Response } from 'express'
import { config } from '../config.js'

// The Logbook on/off switch lives in AIC Control Tower (Manifest → Logbook → APP ON/OFF).
// Every minute Logbook asks the Tower GET /api/agent/entitlements with its aircraft
// token. When the Tower says Logbook is OFF, sign-in and the API answer 403 app_off.
//
// Fails open: no TOWER_URL / TOWER_TOKEN, or a Tower that can't be reached or gives an
// answer we don't understand, leaves Logbook ON with a logged warning, so a Tower
// outage never locks the techs out mid-week.

export type SwitchReason = 'not_configured' | 'tower' | 'unreachable'

export interface SwitchState {
  on: boolean
  reason: SwitchReason
  /** When the Tower last gave a usable answer. */
  checkedAt: Date | null
  /** Why the last check failed, when it did. */
  detail?: string
}

export const OFF_MESSAGE =
  'Logbook is turned off for your company in AIC Control Tower. Ask your office to turn it back on. Nothing already recorded is lost.'

/** Read the Tower's answer. true/false = the switch; null = an answer we can't use. */
export function readSwitch(body: unknown): boolean | null {
  if (!body || typeof body !== 'object') return null
  const ent = (body as { entitlements?: unknown }).entitlements
  if (!ent || typeof ent !== 'object' || Array.isArray(ent)) return null
  const logbook = (ent as Record<string, unknown>).LOGBOOK
  if (logbook === undefined) return false // the Tower knows this company and Logbook isn't in its manifest
  if (!Array.isArray(logbook)) return null
  return logbook.includes('core')
}

type Fetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'manual' },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface TowerSettings {
  url: string
  token: string
  /** Cloudflare Access service token, when the Tower sits behind Access (same pair as
   *  TOWER_ACCESS_ID / TOWER_ACCESS_SECRET in /etc/ged-health-check.conf). */
  accessId?: string
  accessSecret?: string
  timeoutMs?: number
}

/** Headers for one Tower request. Exported for tests. */
export function towerHeaders(s: TowerSettings): Record<string, string> {
  const h: Record<string, string> = { Authorization: `Bearer ${s.token}`, Accept: 'application/json' }
  if (s.accessId) h['CF-Access-Client-Id'] = s.accessId
  if (s.accessSecret) h['CF-Access-Client-Secret'] = s.accessSecret
  return h
}

/** One question to the Tower. Never throws. */
export async function askTower(s: TowerSettings, fetchImpl: Fetch = fetch as unknown as Fetch, now = () => new Date()): Promise<SwitchState> {
  if (!s.url || !s.token) return { on: true, reason: 'not_configured', checkedAt: null }
  try {
    const r = await fetchImpl(`${s.url.replace(/\/+$/, '')}/api/agent/entitlements`, {
      headers: towerHeaders(s),
      signal: AbortSignal.timeout(s.timeoutMs ?? 5000),
      // A redirect here is Cloudflare Access sending us to its sign-in page: say so
      // instead of following it to an HTML page.
      redirect: 'manual',
    })
    if (r.status >= 300 && r.status < 400) {
      const why = s.accessId ? 'check TOWER_ACCESS_ID / TOWER_ACCESS_SECRET' : 'set TOWER_ACCESS_ID / TOWER_ACCESS_SECRET'
      return { on: true, reason: 'unreachable', checkedAt: null, detail: `Control Tower answered ${r.status} (Cloudflare Access sign-in; ${why})` }
    }
    if (!r.ok) return { on: true, reason: 'unreachable', checkedAt: null, detail: `Control Tower answered ${r.status}` }
    const on = readSwitch(await r.json())
    if (on === null) return { on: true, reason: 'unreachable', checkedAt: null, detail: 'Control Tower answer not understood' }
    return { on, reason: 'tower', checkedAt: now() }
  } catch (err) {
    return { on: true, reason: 'unreachable', checkedAt: null, detail: err instanceof Error ? err.message : String(err) }
  }
}

// ─── The live switch ────────────────────────────────────────────────────────

let state: SwitchState = { on: true, reason: 'not_configured', checkedAt: null }
let lastGood: Date | null = null

export const switchState = (): SwitchState => ({ ...state, checkedAt: state.checkedAt ?? lastGood })

/** Apply a check result and log only when something changes. Exported for tests. */
export function applyCheck(next: SwitchState, log: Pick<Console, 'warn' | 'log'> = console): void {
  const prev = state
  if (next.reason === 'tower') lastGood = next.checkedAt
  if (next.reason === 'unreachable' && prev.reason !== 'unreachable') {
    log.warn(`[tower] Can't check the Logbook switch (${next.detail}). Leaving Logbook ON until Control Tower answers.`)
  }
  if (next.reason === 'tower' && prev.reason === 'unreachable') log.log('[tower] Control Tower is answering again.')
  if (next.reason === 'tower' && next.on !== prev.on) {
    log.log(`[tower] Control Tower switched Logbook ${next.on ? 'ON' : 'OFF'}.`)
  }
  state = next
}

/** For tests: back to the start-up state. */
export function resetSwitch(): void {
  state = { on: true, reason: 'not_configured', checkedAt: null }
  lastGood = null
}

/** Check now, then every TOWER_CHECK_SECONDS. Does nothing without TOWER_URL and TOWER_TOKEN. */
export function startTowerSwitch(): void {
  const s: TowerSettings = {
    url: config.towerUrl,
    token: config.towerToken,
    accessId: config.towerAccessId,
    accessSecret: config.towerAccessSecret,
  }
  if (!s.url || !s.token) {
    console.log('[tower] TOWER_URL / TOWER_TOKEN not set: the Control Tower switch is not checked (Logbook stays ON).')
    return
  }
  const tick = () => void askTower(s).then((r) => applyCheck(r))
  tick()
  setInterval(tick, config.towerCheckSeconds * 1000).unref()
}

// ─── Middleware ─────────────────────────────────────────────────────────────

// Still answered while OFF: the liveness check, the sign-in page's settings (so it can
// say why) and the API reference.
const OPEN_PATHS = new Set(['/health', '/auth/config', '/openapi.json', '/docs'])

/** Mounted on /api/v1 before everything else. */
export function logbookSwitch(req: Request, res: Response, next: NextFunction): void {
  if (state.on || OPEN_PATHS.has(req.path)) return next()
  // "Sign in with Dashboard" is a browser navigation: send the browser back to the
  // sign-in page with the message instead of showing raw JSON.
  if (req.method === 'GET' && req.path.startsWith('/auth/dashboard/')) {
    res.redirect(302, `${config.appUrl}/?signin_error=${encodeURIComponent(OFF_MESSAGE)}`)
    return
  }
  res.status(403).json({ error: { code: 'app_off', message: OFF_MESSAGE } })
}
