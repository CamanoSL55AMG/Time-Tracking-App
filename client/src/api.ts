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
  /** repair = an Electronic Repair (SD) ticket from AV Inventory's check-in. */
  kind: 'project' | 'service' | 'shop' | 'repair' | 'other'
  name: string
  code: string
  active: boolean
  /** Job site, sent across from Jetbuilt by GED. Empty when unknown. */
  siteAddress?: string
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
  /** Sold-labor line the hours roll up to: engineering | install | programming | management | other. */
  laborCategory: string
  /** A step of the field day ("Next" walks through these); office phases are not. */
  dayFlow: boolean
  /** Work mode it is offered in. "Next" never leaves the mode. */
  mode: WorkMode
  /** Switched-off phases only come back from allPhases(). */
  active?: boolean
}
export type WorkMode = 'install' | 'service' | 'office' | 'shop' | 'cad' | 'bench'
export const WORK_MODES: WorkMode[] = ['install', 'service', 'office', 'shop', 'cad', 'bench']

/** A service ticket (Service) or task (Shop, Office, CAD) still open: paused when switched away from, closed by the person. */
export interface OpenItem {
  id: string
  personId: string
  jobId: string
  mode: WorkMode
  notes: string
  status: 'open' | 'closed'
  waitingReason: string
  resolution: string
  openedAt: string
  lastWorkedAt: string
  closedAt: string | null
  job: Job
  /** Hours on it so far, all days. */
  hours: number
  /** The task last used on it, to resume with. */
  lastPhaseId: string | null
  /** The open segment is on it right now. */
  current: boolean
}
/** Everyone's open items, for the office. */
export interface TeamItem extends Omit<OpenItem, 'job' | 'lastPhaseId' | 'current'> {
  job: { id: string; name: string; code: string; kind: string }
  person: { id: string; name: string; email: string }
  onNow: boolean
}
/** Offered when leaving an item open at the end of the day (any text works too). */
export const KEEP_REASONS = ['Waiting on parts', 'Return visit scheduled', 'Needs the office', 'Continue tomorrow']

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
  /** The job this person last punched on (any day), if it is still open to time. */
  lastJob?: Job | null
  /** Jobs worked in the last two weeks, newest first: the quick-switch list. */
  recentJobs?: Job[]
  /** "Stop project" while staying on the clock charges time here. */
  overhead?: { job: Job; phase: Phase | null } | null
  /** Off the clock: the last segment today, for "Back to …" after a break. */
  lastSegment?: Punch | null
  /** Service tickets and Shop / Office / CAD tasks still open, newest first. */
  openItems?: OpenItem[]
  /** Set while Timesheets.com still runs payroll: each punch is made there too. */
  parallelRun?: { until: string; url: string } | null
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
  /** Steps in the field day of this phase's mode. */
  phaseSteps?: number | null
  mode?: WorkMode | null
  since: string | null
  lastOut: string | null
  hoursToday: number
  atShop: boolean | null
  /** Clocked in at the job's site; null when the job has no site position or the punch no GPS. */
  atSite?: boolean | null
}
export interface Board {
  date: string
  asOf: string
  phaseCount: number
  rows: BoardRow[]
}
export interface BillingRules {
  travelHours: number
  includedHours: number
  incrementMinutes: number
}
export interface ServiceCall {
  jobId: string
  jobName: string
  jobCode: string
  day: string
  techs: string[]
  actualTravelHours: number
  actualOnSiteHours: number
  billedTravelHours: number
  tripCharges: number
  includedHours: number
  billableHours: number
  open: boolean
}
export interface ServiceBilling {
  rules: BillingRules
  rows: ServiceCall[]
  totals: { calls: number; tripCharges: number; billedTravelHours: number; billableHours: number; actualTravelHours: number; actualOnSiteHours: number }
}
// ─── Expenses ───────────────────────────────────────────────────────────────

export interface ExpenseCategory {
  id: string
  name: string
  kind: 'expense' | 'mileage'
  accountCode: string
  sortOrder: number
  active: boolean
}
export type ExpenseStatus = 'draft' | 'submitted' | 'approved' | 'rejected'
export interface Expense {
  id: string
  personId: string
  person: { id: string; name: string; email: string }
  jobId: string | null
  job: { id: string; name: string; code: string; kind: string } | null
  punchId: string | null
  date: string
  categoryId: string
  category: { id: string; name: string; kind: 'expense' | 'mileage'; accountCode: string }
  amount: number
  miles: number | null
  ratePerMile: number | null
  paidBy: 'employee' | 'company_card'
  vendor: string
  notes: string
  hasReceipt: boolean
  /** The account this line posts to in accounting. */
  postingAccount: string
  status: ExpenseStatus
  decisionNote: string
  decidedAt: string | null
  createdAt: string
}
export interface ExpenseTotals {
  count: number
  amount: number
  reimbursable: number
  waiting: number
  approved: number
}
export interface ExpenseBody {
  currentFlight?: boolean
  jobId?: string | null
  date?: string
  categoryId?: string
  amount?: number
  miles?: number
  paidBy?: 'employee' | 'company_card'
  vendor?: string
  notes?: string
  draft?: boolean
}
export const fmtMoney = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

export interface ApiKey {
  id: string
  name: string
  prefix: string
  scopes: string[]
  createdAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}
// ─── Weekly timesheets ──────────────────────────────────────────────────────

export type SheetStatus = 'open' | 'signed' | 'approved'
export interface TimeException {
  code: 'missed_clock_out' | 'long_day' | 'away_from_site' | 'away_from_shop' | 'edited' | 'sent_late'
  severity: 'problem' | 'note'
  personId: string
  personName: string
  date: string
  punchId?: string
  message: string
}
export interface WeekSegment {
  id: string
  clockIn: string
  clockOut: string | null
  notes: string
  source: string
  job: { id: string; name: string; code: string; kind: string }
  phase: { id: string; key: string; name: string; short: string; laborCategory: string } | null
  edited: boolean
}
interface SheetState {
  status: SheetStatus
  signedAt: string | null
  approvedAt: string | null
  approvedBy: string | null
  note: string
}
export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'withdrawn'
export interface ChangeRequest {
  id: string
  kind: 'edit' | 'add'
  person: { id: string; name: string }
  requestedBy: string
  punchId: string | null
  weekStart: string
  before: { clockIn: string; clockOut: string | null; jobId: string; jobName: string; phaseId: string | null; phaseName: string | null; notes: string } | null
  change: { clockIn: string | null; clockOut: string | null; jobId: string | null; jobName: string | null; phaseId: string | null; phaseName: string | null; notes: string | null }
  reason: string
  status: RequestStatus
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string
  createdAt: string
}
export interface RequestBody {
  punchId?: string
  clockIn?: string
  clockOut?: string
  jobId?: string
  phaseId?: string
  notes?: string
  reason: string
}

export interface PersonWeek extends SheetState {
  person: { id: string; name: string; email: string }
  weekStart: string
  weekEnd: string
  timezone: string
  days: { date: string; hours: number; segments: WeekSegment[] }[]
  hours: number
  openSegment: boolean
  weekOver: boolean
  hoursAtSignOff: number | null
  exceptions: TimeException[]
  requests: ChangeRequest[]
}
export interface WeekSheetRow extends SheetState {
  person: { id: string; name: string; email: string; active: boolean; role: string }
  daily: number[]
  hours: number
  openSegment: boolean
  problems: number
  pendingRequests: number
}
export interface WeekSheet {
  weekStart: string
  weekEnd: string
  days: string[]
  weekOver: boolean
  rows: WeekSheetRow[]
  quiet: { id: string; name: string }[]
  exceptions: TimeException[]
  counts: { approved: number; signed: number; open: number; pendingRequests: number }
}
export interface CrewResult {
  personId: string
  name: string
  ok: boolean
  code?: string
  message?: string
  onClock?: boolean
  jobName?: string
  phaseName?: string
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
  authConfig: () => http.get<{ googleClientId: string | null; dashboard?: boolean }>('/auth/config').then((r) => r.data),
  google: (credential: string) => http.post<{ token: string; person: Person }>('/auth/google', { credential }).then((r) => r.data),
  me: () => http.get<{ person: Person | null; scopes: string[] }>('/auth/me').then((r) => r.data),
  changePassword: (current: string, next: string) => http.post('/auth/password', { current, next }).then((r) => r.data),

  state: () => http.get<DayState>('/me/state').then((r) => r.data),
  punchIn: (jobId: string, phaseId: string | undefined, notes?: string) => punch('in', { jobId, phaseId, notes: notes?.trim() || undefined }),
  punchNext: (phaseId?: string) => punch('next', { phaseId }),
  punchOut: () => punch('out', {}),

  jobs: (q?: string) => http.get<{ data: Job[] }>('/jobs', { params: { q: q || undefined, limit: 500 } }).then((r) => r.data.data),
  allJobs: () => http.get<{ data: Job[] }>('/jobs', { params: { active: 'all', limit: 500 } }).then((r) => r.data.data),
  addJob: (job: { name: string; kind: string; code: string }) => http.post<{ job: Job }>('/jobs', job).then((r) => r.data.job),
  setJobActive: (id: string, active: boolean) => http.patch<{ job: Job }>(`/jobs/${id}`, { active }).then((r) => r.data.job),

  phases: () => http.get<{ data: Phase[] }>('/phases').then((r) => r.data.data),
  allPhases: () => http.get<{ data: Phase[] }>('/phases', { params: { all: 'true' } }).then((r) => r.data.data),
  addPhase: (p: { name: string; short?: string; laborCategory: string; dayFlow: boolean; mode: WorkMode; atShop?: boolean }) =>
    http.post<{ phase: Phase }>('/phases', p).then((r) => r.data.phase),
  updatePhase: (id: string, p: Partial<Pick<Phase, 'name' | 'short' | 'sortOrder' | 'laborCategory' | 'dayFlow' | 'mode' | 'active'>>) =>
    http.patch<{ phase: Phase }>(`/phases/${id}`, p).then((r) => r.data.phase),

  board: () => http.get<Board>('/board').then((r) => r.data),

  closeItem: (id: string, resolution: string) => http.post<{ item: OpenItem }>(`/me/items/${id}/close`, { resolution }).then((r) => r.data.item),
  keepItem: (id: string, reason: string) => http.post<{ item: OpenItem }>(`/me/items/${id}/keep`, { reason }).then((r) => r.data.item),
  teamItems: () => http.get<{ data: TeamItem[] }>('/items').then((r) => r.data.data),
  serviceBilling: (from: string, to: string) => http.get<ServiceBilling>('/reports/service-billing', { params: { from, to } }).then((r) => r.data),
  billingRules: () => http.get<{ rules: BillingRules }>('/company/service-billing').then((r) => r.data.rules),
  saveBillingRules: (rules: Partial<BillingRules>) => http.patch<{ rules: BillingRules }>('/company/service-billing', rules).then((r) => r.data.rules),

  myWeek: (week?: string) => http.get<PersonWeek>('/me/week', { params: { week } }).then((r) => r.data),
  signWeek: (week: string) => http.post<PersonWeek>('/me/week/sign', { week }).then((r) => r.data),
  weekSheet: (week?: string) => http.get<WeekSheet>('/timesheets', { params: { week } }).then((r) => r.data),
  personWeek: (personId: string, week: string) => http.get<PersonWeek>(`/timesheets/${personId}`, { params: { week } }).then((r) => r.data),
  approve: (personIds: string[], week: string, note?: string) =>
    http
      .post<{ results: { personId: string; ok: boolean; code?: string; message?: string }[]; approved: number }>('/timesheets/approve', { personIds, week, note })
      .then((r) => r.data),
  editPunch: (id: string, body: { clockIn?: string; clockOut?: string | null; notes?: string; reason: string }) =>
    http.patch<{ punch: Punch }>(`/punches/${id}`, body).then((r) => r.data.punch),
  askChange: (body: RequestBody) => http.post<{ request: ChangeRequest }>('/me/requests', body).then((r) => r.data.request),
  withdrawRequest: (id: string) => http.post<{ request: ChangeRequest }>(`/me/requests/${id}/withdraw`).then((r) => r.data.request),
  pendingRequests: () => http.get<{ data: ChangeRequest[] }>('/requests', { params: { status: 'pending' } }).then((r) => r.data.data),
  decideRequest: (id: string, decision: 'approve' | 'reject', note: string) =>
    http.post<{ request: ChangeRequest }>(`/requests/${id}/${decision}`, { note }).then((r) => r.data.request),
  reopen: (personId: string, week: string, reason: string) => http.post<PersonWeek>('/timesheets/reopen', { personId, week, reason }).then((r) => r.data),
  crew: async (kind: PunchKind, body: { personIds: string[]; jobId?: string; phaseId?: string }) => {
    const geo = await grabGeo()
    const clientId = newId()
    return http
      .post<{ results: CrewResult[]; punched: number }>(`/crew/${kind}`, { ...body, geo: geo ?? undefined, clientId }, { headers: { 'Idempotency-Key': clientId } })
      .then((r) => r.data)
  },

  expenseCategories: (all = false) =>
    http.get<{ data: ExpenseCategory[]; mileageRate: number; reimbursementAccountCode: string }>('/expense-categories', { params: { all: all ? 'true' : undefined } }).then((r) => r.data),
  addExpenseCategory: (c: { name: string; kind: 'expense' | 'mileage'; accountCode?: string }) => http.post<{ category: ExpenseCategory }>('/expense-categories', c).then((r) => r.data.category),
  updateExpenseCategory: (id: string, c: Partial<Pick<ExpenseCategory, 'name' | 'accountCode' | 'active'>>) =>
    http.patch<{ category: ExpenseCategory }>(`/expense-categories/${id}`, c).then((r) => r.data.category),
  setMileageRate: (mileageRate: number) => http.patch<{ mileageRate: number }>('/company/mileage-rate', { mileageRate }).then((r) => r.data.mileageRate),
  saveExpenseSettings: (s: { mileageRate?: number; reimbursementAccountCode?: string }) =>
    http.patch<{ mileageRate: number; reimbursementAccountCode: string }>('/company/expense-settings', s).then((r) => r.data),
  myExpenses: (from?: string, to?: string) => http.get<{ data: Expense[]; totals: ExpenseTotals }>('/me/expenses', { params: { from, to } }).then((r) => r.data),
  addExpense: (body: ExpenseBody) => {
    const clientId = newId()
    return http.post<{ expense: Expense }>('/me/expenses', { ...body, clientId }, { headers: { 'Idempotency-Key': clientId } }).then((r) => r.data.expense)
  },
  changeExpense: (id: string, body: ExpenseBody) => http.patch<{ expense: Expense }>(`/me/expenses/${id}`, body).then((r) => r.data.expense),
  deleteExpense: (id: string) => http.delete(`/me/expenses/${id}`).then((r) => r.data),
  attachReceipt: (id: string, contentType: string, data: string) =>
    http.post<{ expense: Expense }>(`/me/expenses/${id}/receipt`, { contentType, data }, { timeout: 90_000 }).then((r) => r.data.expense),
  /** The receipt as a blob URL (the file needs the sign-in header, so a plain link will not do). */
  receiptUrl: (id: string) => http.get<Blob>(`/expenses/${id}/receipt`, { responseType: 'blob' }).then((r) => URL.createObjectURL(r.data)),
  expenses: (params: { status?: ExpenseStatus; from?: string; to?: string; personId?: string }) =>
    http.get<{ data: Expense[]; totals: ExpenseTotals }>('/expenses', { params }).then((r) => r.data),
  decideExpense: (id: string, decision: 'approve' | 'reject', note: string) =>
    http.post<{ expense: Expense }>(`/expenses/${id}/${decision}`, { note }).then((r) => r.data.expense),

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

/** "2026-10-12" -> "Mon Oct 12" (dates are calendar days, not instants). */
export const fmtDay = (ymd: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric' }) =>
  new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-US', { ...opts, timeZone: 'UTC' })

/** "2026-10-12T07:05" in this browser's time zone, for a datetime-local input. */
export const toLocalInput = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

/** Seven days on from a YYYY-MM-DD date (negative to go back). */
export const shiftWeek = (ymd: string, weeks: number) => {
  const d = new Date(`${ymd}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + weeks * 7)
  return d.toISOString().slice(0, 10)
}

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
