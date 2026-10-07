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
  asOf: string
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
  // Each tap carries its own id, so a retry after a dropped connection cannot double-punch.
  punchIn: async (jobId: string, phaseId: string | undefined) =>
    http.post<PunchResult>('/punches/in', { jobId, phaseId, geo: await grabGeo(), clientId: newId() }).then((r) => r.data),
  punchNext: async (phaseId?: string) =>
    http.post<PunchResult>('/punches/next', { phaseId, geo: await grabGeo(), clientId: newId() }).then((r) => r.data),
  punchOut: async () => http.post<PunchResult>('/punches/out', { geo: await grabGeo() }).then((r) => r.data),

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
}

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
