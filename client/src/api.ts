import axios, { AxiosError } from 'axios'

// Everything the page says to the server goes through here.

const TOKEN_KEY = 'tt_token'
export const getToken = () => localStorage.getItem(TOKEN_KEY)
export const setToken = (t: string | null) => (t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY))

export const http = axios.create({ baseURL: '/api/v1', timeout: 20_000 })

http.interceptors.request.use((cfg) => {
  const t = getToken()
  if (t) cfg.headers.Authorization = `Bearer ${t}`
  return cfg
})

let onSignedOut: (() => void) | null = null
export const setSignedOutHandler = (fn: () => void) => {
  onSignedOut = fn
}
http.interceptors.response.use(
  (r) => r,
  (err: AxiosError) => {
    if (err.response?.status === 401 && getToken() && !String(err.config?.url ?? '').startsWith('/auth/')) {
      setToken(null)
      onSignedOut?.()
    }
    return Promise.reject(err)
  },
)

/** A sentence a person can act on, whatever went wrong. */
export function errorText(err: unknown): string {
  if (axios.isAxiosError(err)) {
    const msg = (err.response?.data as { error?: { message?: string } } | undefined)?.error?.message
    if (msg) return msg
    if (!err.response) return 'No connection to the server. Nothing was recorded. Check your signal and try again.'
    return `The server answered ${err.response.status}.`
  }
  return err instanceof Error ? err.message : 'Something went wrong.'
}

// ─── Shapes ─────────────────────────────────────────────────────────────────

export interface Person {
  id: string
  email: string
  name: string
  initials: string
  role: 'tech' | 'lead' | 'manager' | 'payroll' | 'admin'
  active: boolean
  scopes: string[]
}
export interface Job {
  id: string
  kind: 'project' | 'service' | 'shop' | 'other'
  name: string
  code: string
  active: boolean
  siteLat?: number | null
  siteLng?: number | null
  siteRadiusM?: number | null
  refs?: { system: string; externalId: string }[]
}
export interface Phase {
  id: string
  key: string
  name: string
  short: string
  sortOrder: number
  atShop: boolean
}
export interface Punch {
  id: string
  personId: string
  jobId: string
  phaseId: string | null
  clockIn: string
  clockOut: string | null
  notes: string
  job: Job
  phase: Phase | null
}
export interface DayState {
  date: string
  timezone: string
  onClock: boolean
  open: Punch | null
  today: Punch[]
  hoursToday: number
  byJob: { jobId: string; jobName: string; hours: number }[]
  nextPhase: Phase | null
  phases: Phase[]
  assignments: Assignment[]
  asOf: string
}
export interface Assignment {
  id: string
  title: string
  shopTime: string
  job: Job | null
}
export interface BoardRow {
  personId: string
  name: string
  email: string
  onClock: boolean
  jobName: string
  phaseName: string
  phaseIndex: number | null
  since: string | null
  lastOut: string | null
  hoursToday: number
  atShop: boolean | null
}
export interface Board {
  date: string
  asOf: string
  phaseCount: number
  rows: BoardRow[]
}
export interface ApiKey {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}
export interface Geo {
  lat: number
  lng: number
  accuracyM?: number
}

// ─── Review shapes ──────────────────────────────────────────────────────────

export interface PunchEdit {
  id: string
  at: string
  reason: string
  editedById: string | null
  before: Record<string, unknown>
  after: Record<string, unknown>
}
export interface ReviewPunch extends Punch {
  source: string
  enteredById: string | null
  inLat: number | null
  inLng: number | null
  edits: PunchEdit[]
}
export interface TimeException {
  type: string
  severity: 'warn' | 'info'
  personId: string
  personName: string
  date: string
  punchId?: string
  message: string
}
export interface PersonWeek {
  week: string
  person: { id: string; name: string; email: string }
  ended: boolean
  hours: number
  onClock: boolean
  signedAt: string | null
  approvedAt: string | null
  approvedBy: string
  days: { date: string; hours: number; punches: ReviewPunch[]; exceptions: TimeException[] }[]
}
export interface WeekRow {
  personId: string
  name: string
  email: string
  role: string
  active: boolean
  hours: number
  segments: number
  onClock: boolean
  signedAt: string | null
  approvedAt: string | null
  approvedBy: string
  approvedHours: number | null
  warnings: number
  notes: number
}
export interface WeekSummary {
  week: string
  days: string[]
  weekStartDay: number
  ended: boolean
  totals: { people: number; hours: number; signed: number; approved: number }
  rows: WeekRow[]
}
export interface ApproveResult {
  personId: string
  ok: boolean
  code?: string
  message?: string
  hours?: number
}
export interface CrewResult {
  personId: string
  name: string
  ok: boolean
  message?: string
}
export interface Company {
  id: string
  name: string
  timezone: string
  weekStartDay: number
  weekStartName: string
  shopLat: number | null
  shopLng: number | null
  shopRadiusM: number
}
export interface Webhook {
  id: string
  url: string
  events: string[]
  active: boolean
  createdAt: string
  delivered: number
  pending: number
  failed: number
}
export interface Reconcile {
  system: string
  from: string
  to: string
  toleranceHours: number
  lastSyncedAt: string | null
  totals: { ours: number; theirs: number; days: number; mismatchedDays: number }
  people: { personId: string; name: string; ours: number; theirs: number; diff: number; mismatchedDays: number }[]
  rows: { personId: string; name: string; date: string; ours: number; theirs: number | null; diff: number; match: boolean }[]
}

/** The phone's position right now, or null if it is refused, unavailable or slow. Never throws. */
export const grabGeo = (timeoutMs = 6000): Promise<Geo | null> =>
  new Promise((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null)
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    )
  })

const newId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)

type PunchResult = { punch: Punch; state: DayState }

export const api = {
  login: (email: string, password: string) => http.post<{ token: string; person: Person }>('/auth/login', { email, password }).then((r) => r.data),
  sso: (token: string) => http.post<{ token: string; person: Person }>('/auth/sso', { token }).then((r) => r.data),
  me: () => http.get<{ person: Person | null; scopes: string[] }>('/auth/me').then((r) => r.data),
  changePassword: (current: string, next: string) => http.post('/auth/password', { current, next }).then((r) => r.data),

  state: () => http.get<DayState>('/me/state').then((r) => r.data),
  punchIn: (jobId: string, phaseId: string | undefined) => punch('in', { jobId, phaseId }),
  punchNext: (phaseId?: string) => punch('next', { phaseId }),
  punchOut: () => punch('out', {}),

  jobs: (q?: string) => http.get<{ data: Job[] }>('/jobs', { params: { q: q || undefined, limit: 500 } }).then((r) => r.data.data),
  allJobs: () => http.get<{ data: Job[] }>('/jobs', { params: { active: 'all', limit: 500 } }).then((r) => r.data.data),
  addJob: (job: { name: string; kind: string; code: string }) => http.post<{ job: Job }>('/jobs', job).then((r) => r.data.job),
  setJobActive: (id: string, active: boolean) => http.patch<{ job: Job }>(`/jobs/${id}`, { active }).then((r) => r.data.job),

  board: () => http.get<Board>('/board').then((r) => r.data),

  people: () => http.get<{ data: Person[] }>('/people').then((r) => r.data.data),
  savePerson: (email: string, body: { name?: string; initials?: string; role?: string; active?: boolean; password?: string }) =>
    http.put<{ created: boolean; person: Person }>(`/people/by-email/${encodeURIComponent(email)}`, body).then((r) => r.data),

  keys: () => http.get<{ data: ApiKey[]; availableScopes: string[] }>('/api-keys').then((r) => r.data),
  createKey: (name: string, scopes: string[]) => http.post<{ key: string; apiKey: ApiKey }>('/api-keys', { name, scopes }).then((r) => r.data),
  revokeKey: (id: string) => http.delete(`/api-keys/${id}`).then((r) => r.data),

  // Review
  myWeek: (week?: string) => http.get<PersonWeek>('/me/week', { params: { week } }).then((r) => r.data),
  signWeek: (week: string) => http.post('/approvals/sign', { week }).then((r) => r.data),
  weekSummary: (week?: string) => http.get<WeekSummary>('/approvals', { params: { week } }).then((r) => r.data),
  personWeek: (personId: string, week: string) => http.get<PersonWeek>(`/approvals/${personId}`, { params: { week } }).then((r) => r.data),
  approve: (week: string, personIds: string[]) =>
    http.post<{ results: ApproveResult[]; approved: number; failed: number }>('/approvals/approve', { week, personIds }).then((r) => r.data),
  reopen: (week: string, personId: string, reason: string) => http.post('/approvals/reopen', { week, personId, reason }).then((r) => r.data),
  editPunch: (id: string, body: { clockIn?: string; clockOut?: string | null; jobId?: string; phaseId?: string | null; notes?: string; reason: string }) =>
    http.patch<{ punch: Punch }>(`/punches/${id}`, body).then((r) => r.data.punch),
  addPunch: (body: { personId: string; jobId: string; phaseId?: string | null; clockIn: string; clockOut: string; notes?: string; reason: string }) =>
    http.post<{ punch: Punch }>('/punches', body).then((r) => r.data.punch),
  phases: () => http.get<{ data: Phase[] }>('/phases').then((r) => r.data.data),
  crew: (action: PunchKind, personIds: string[], fields: { jobId?: string; phaseId?: string; geo?: Geo | null }) =>
    http
      .post<{ results: CrewResult[]; ok: number; failed: number }>('/punches/crew', { action, personIds, ...fields, geo: fields.geo ?? undefined }, { headers: { 'Idempotency-Key': newId() } })
      .then((r) => r.data),
  reconcile: (from: string, to: string) => http.get<Reconcile>('/reports/reconcile', { params: { from, to } }).then((r) => r.data),

  // Settings
  company: () => http.get<{ company: Company }>('/company').then((r) => r.data.company),
  saveCompany: (body: Partial<Omit<Company, 'id' | 'weekStartName'>>) => http.patch<{ company: Company }>('/company', body).then((r) => r.data.company),
  saveJob: (id: string, body: { siteLat?: number | null; siteLng?: number | null; siteRadiusM?: number | null }) =>
    http.patch<{ job: Job }>(`/jobs/${id}`, body).then((r) => r.data.job),
  webhooks: () => http.get<{ data: Webhook[]; eventTypes: string[] }>('/webhooks').then((r) => r.data),
  addWebhook: (url: string, events: string[]) => http.post<{ webhook: Webhook; secret: string }>('/webhooks', { url, events }).then((r) => r.data),
  setWebhookActive: (id: string, active: boolean) => http.patch(`/webhooks/${id}`, { active }).then((r) => r.data),
  testWebhook: (id: string) => http.post<{ result: { ok: boolean; code: number | null; error: string } }>(`/webhooks/${id}/test`).then((r) => r.data.result),
  retryWebhook: (id: string) => http.post<{ requeued: number }>(`/webhooks/${id}/retry`).then((r) => r.data),
  deleteWebhook: (id: string) => http.delete(`/webhooks/${id}`).then((r) => r.data),
}

// ─── Dates ──────────────────────────────────────────────────────────────────

/** YYYY-MM-DD plus whole days. */
export const addDays = (ymd: string, days: number) => {
  const [y, m, d] = ymd.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}
/** "Mon Oct 5" for a YYYY-MM-DD date. */
export const fmtDay = (ymd: string) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
/** "Oct 4 – 10" for the week starting on `week`. */
export const fmtWeek = (week: string) => {
  const a = new Date(`${week}T12:00:00Z`)
  const b = new Date(`${addDays(week, 6)}T12:00:00Z`)
  const mo = (d: Date) => d.toLocaleDateString([], { month: 'short', timeZone: 'UTC' })
  return mo(a) === mo(b) ? `${mo(a)} ${a.getUTCDate()} – ${b.getUTCDate()}` : `${mo(a)} ${a.getUTCDate()} – ${mo(b)} ${b.getUTCDate()}`
}
/** Value for a datetime-local input, in this device's timezone. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const fromLocalInput = (v: string) => (v ? new Date(v).toISOString() : '')

// ─── Formatting ─────────────────────────────────────────────────────────────

export const fmtTime = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '—'

export const fmtElapsed = (fromIso: string | null | undefined, to: Date | string = new Date()) => {
  if (!fromIso) return ''
  const mins = Math.max(0, Math.floor((new Date(to).getTime() - new Date(fromIso).getTime()) / 60_000))
  const h = Math.floor(mins / 60)
  return h ? `${h}h ${String(mins % 60).padStart(2, '0')}m` : `${mins}m`
}

export const fmtHours = (h: number) => `${h.toFixed(2)} h`

// ─── Punches that survive a dead signal ─────────────────────────────────────
// A tap that cannot reach the server is kept on the phone with the time it
// happened, and sent later in the same order. Each one carries its own id, so a
// repeat (a retry after a dropped answer) is recognised by the server and does
// nothing twice. While anything is waiting, later taps wait behind it.

export type PunchKind = 'in' | 'next' | 'out'
interface QueuedPunch {
  id: string
  kind: PunchKind
  body: Record<string, unknown>
}
export type PunchOutcome = { sent: true; state: DayState } | { sent: false; at: string }

const QUEUE_KEY = 'tt_punch_queue'
const FAILED_KEY = 'tt_punch_failed'
const listeners = new Set<() => void>()

const readJson = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}
const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* storage full or blocked: nothing more we can do here */
  }
  listeners.forEach((fn) => fn())
}

export const queuedPunches = () => readJson<QueuedPunch[]>(QUEUE_KEY, [])
/** Messages for queued punches the server refused once the signal came back. */
export const failedPunches = () => readJson<string[]>(FAILED_KEY, [])
export const clearFailedPunches = () => writeJson(FAILED_KEY, [])
export const onQueueChange = (fn: () => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/** No answer at all (as opposed to an answer that says no). */
const isOffline = (err: unknown) => axios.isAxiosError(err) && !err.response && err.code !== 'ERR_CANCELED'

const send = (q: QueuedPunch) => http.post<PunchResult>(`/punches/${q.kind}`, q.body, { headers: { 'Idempotency-Key': q.id } })

async function punch(kind: PunchKind, fields: Record<string, unknown>): Promise<PunchOutcome> {
  const id = newId()
  const geo = await grabGeo()
  const body: Record<string, unknown> = { ...fields, geo: geo ?? undefined }
  if (kind !== 'out') body.clientId = id
  const tappedAt = new Date().toISOString()

  const keep = () => {
    // Waiting punches carry the moment of the tap; online ones use the server's clock.
    writeJson(QUEUE_KEY, [...queuedPunches(), { id, kind, body: { ...body, at: tappedAt } }])
    return { sent: false as const, at: tappedAt }
  }
  if (queuedPunches().length) {
    const outcome = keep()
    void flushPunches()
    return outcome
  }
  try {
    const r = await send({ id, kind, body })
    return { sent: true, state: r.data.state }
  } catch (err) {
    if (isOffline(err)) return keep()
    throw err
  }
}

let flushing = false
/** Send waiting punches in order. Stops at the first one that still cannot get through. */
export async function flushPunches(): Promise<boolean> {
  if (flushing || !getToken()) return false
  flushing = true
  let sentAny = false
  try {
    for (;;) {
      const q = queuedPunches()
      if (!q.length) break
      try {
        await send(q[0])
        sentAny = true
      } catch (err) {
        if (isOffline(err)) break
        // Signed out: keep the punch until someone signs in again.
        if (axios.isAxiosError(err) && err.response?.status === 401) break
        const code = axios.isAxiosError(err) ? (err.response?.data as { error?: { code?: string } } | undefined)?.error?.code : undefined
        // Clocking out when already out is not worth a warning.
        if (!(q[0].kind === 'out' && code === 'not_clocked_in')) {
          const when = new Date(String(q[0].body.at)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
          writeJson(FAILED_KEY, [...failedPunches(), `${q[0].kind === 'in' ? 'Clock in' : q[0].kind === 'next' ? 'Next phase' : 'Clock out'} at ${when}: ${errorText(err)}`])
        }
      }
      writeJson(QUEUE_KEY, queuedPunches().slice(1))
    }
  } finally {
    flushing = false
  }
  return sentAny
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flushPunches())
  setInterval(() => {
    if (queuedPunches().length) void flushPunches()
  }, 20_000)
}
