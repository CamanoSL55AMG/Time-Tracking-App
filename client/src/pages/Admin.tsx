import { useCallback, useEffect, useState, type ReactNode } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Tab,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import { api, errorText, fmtTime, WORK_MODES, type ApiKey, type BillingRules, type Job, type Person, type Phase, type WorkMode } from '../api'
import { MODE_INFO } from './modes'

// People, jobs, phases and integration keys. Most jobs arrive from GED through the
// API; this page is for the ones added by hand and for seeing what is there.

type Section = 'people' | 'jobs' | 'phases' | 'expenses' | 'billing' | 'keys'

export default function AdminPage({ me }: { me: Person }) {
  const isAdmin = me.scopes.includes('keys:manage')
  const canEditJobs = me.scopes.includes('jobs:write')
  const [section, setSection] = useState<Section>('people')
  return (
    <Stack spacing={2}>
      <Tabs value={section} onChange={(_, v: Section) => setSection(v)} variant="scrollable" allowScrollButtonsMobile>
        <Tab value="people" label="People" />
        <Tab value="jobs" label="Jobs" />
        {canEditJobs && <Tab value="phases" label="Phases" />}
        {canEditJobs && <Tab value="expenses" label="Expenses" />}
        {canEditJobs && <Tab value="billing" label="Service billing" />}
        {isAdmin && <Tab value="keys" label="API keys" />}
      </Tabs>
      {section === 'people' && <People isAdmin={isAdmin} />}
      {section === 'jobs' && <Jobs />}
      {section === 'phases' && canEditJobs && <Phases />}
      {section === 'expenses' && canEditJobs && <ExpenseSetup />}
      {section === 'billing' && canEditJobs && <Billing />}
      {section === 'keys' && isAdmin && <Keys />}
    </Stack>
  )
}

function useLoader<T>(fn: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      setData(await fn())
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, setError, load }
}

const Row = ({ children, dim }: { children: ReactNode; dim?: boolean }) => (
  <Paper sx={{ p: 1.5, opacity: dim ? 0.55 : 1 }}>
    <Stack direction="row" spacing={1.5} alignItems="center">
      {children}
    </Stack>
  </Paper>
)

// ─── People ─────────────────────────────────────────────────────────────────

const ROLES: Person['role'][] = ['tech', 'lead', 'manager', 'payroll', 'admin']

function People({ isAdmin }: { isAdmin: boolean }) {
  const { data, error, setError, load } = useLoader(api.people)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ email: '', name: '', initials: '', role: 'tech', password: '' })
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api.savePerson(form.email.trim(), {
        name: form.name.trim(),
        initials: form.initials.trim(),
        role: form.role,
        password: form.password || undefined,
      })
      setAdding(false)
      setForm({ email: '', name: '', initials: '', role: 'tech', password: '' })
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const toggle = async (p: Person) => {
    try {
      await api.savePerson(p.email, { active: !p.active })
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Stack spacing={1.5}>
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button variant="contained" onClick={() => setAdding(true)}>
          Add person
        </Button>
      </Box>
      {(data ?? []).map((p) => (
        <Row key={p.id} dim={!p.active}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600 }} noWrap>
              {p.name} {p.initials && <Typography component="span" color="text.secondary">({p.initials})</Typography>}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {p.email}
            </Typography>
          </Box>
          <Chip size="small" label={p.role} />
          <Switch checked={p.active} onChange={() => void toggle(p)} inputProps={{ 'aria-label': `${p.name} active` }} />
        </Row>
      ))}

      <Dialog open={adding} onClose={() => setAdding(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add person</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label="Email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField label="Initials" value={form.initials} onChange={(e) => setForm({ ...form, initials: e.target.value })} helperText="As written on the job calendar" />
            <TextField select label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              {ROLES.filter((r) => isAdmin || r !== 'admin').map((r) => (
                <MenuItem key={r} value={r}>
                  {r}
                </MenuItem>
              ))}
            </TextField>
            {isAdmin && (
              <TextField
                label="Starting password"
                type="password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                helperText="At least 10 characters. Leave blank if they sign in from AIC Terminal"
              />
            )}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={busy || !form.email.includes('@') || !form.name.trim() || (form.password.length > 0 && form.password.length < 10)}>
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

function Jobs() {
  const { data, error, setError, load } = useLoader(api.allJobs)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ name: '', kind: 'project', code: '' })
  const [busy, setBusy] = useState(false)

  const save = async () => {
    setBusy(true)
    try {
      await api.addJob({ name: form.name.trim(), kind: form.kind, code: form.code.trim() })
      setAdding(false)
      setForm({ name: '', kind: 'project', code: '' })
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const toggle = async (j: Job) => {
    try {
      await api.setJobActive(j.id, !j.active)
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Stack spacing={1.5}>
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button variant="contained" onClick={() => setAdding(true)}>
          Add job
        </Button>
      </Box>
      {(data ?? []).map((j) => (
        <Row key={j.id} dim={!j.active}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600 }} noWrap>
              {j.name}
            </Typography>
            <Typography variant="body2" color="text.secondary" noWrap>
              {[j.code, ...(j.refs ?? []).map((r) => `${r.system}: ${r.externalId}`)].filter(Boolean).join(' · ') || 'Added by hand'}
            </Typography>
          </Box>
          <Chip size="small" label={j.kind} />
          <Switch checked={j.active} onChange={() => void toggle(j)} inputProps={{ 'aria-label': `${j.name} open for time` }} />
        </Row>
      ))}

      <Dialog open={adding} onClose={() => setAdding(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add job</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField label="Number or code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} helperText="P-number, service ticket…" />
            <TextField select label="Kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {['project', 'service', 'shop', 'repair', 'other'].map((k) => (
                <MenuItem key={k} value={k}>
                  {k}
                </MenuItem>
              ))}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={busy || !form.name.trim()}>
            Add
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

// ─── Phases ─────────────────────────────────────────────────────────────────
// The phase list techs pick from. Field-day steps are walked with "Next" in this
// order; office phases are picked directly. Each phase's labor category decides
// which sold-labor line in Jetbuilt its hours count against.

const CATEGORIES: { value: string; label: string }[] = [
  { value: 'install', label: 'Install' },
  { value: 'engineering', label: 'Engineering' },
  { value: 'programming', label: 'Programming' },
  { value: 'management', label: 'Project management' },
  { value: 'service', label: 'Service' },
  { value: 'other', label: 'Other' },
]

function Phases() {
  const { data, error, setError, load } = useLoader(api.allPhases)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Phase | null>(null)
  const [form, setForm] = useState<{ name: string; short: string; laborCategory: string; dayFlow: boolean; mode: WorkMode }>({
    name: '',
    short: '',
    laborCategory: 'install',
    dayFlow: false,
    mode: 'office',
  })
  const [busy, setBusy] = useState(false)
  const phases = data ?? []

  const update = async (p: Phase, patch: Parameters<typeof api.updatePhase>[1]) => {
    try {
      await api.updatePhase(p.id, patch)
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }
  // Swap places with the neighbour above or below.
  const move = async (i: number, dir: -1 | 1) => {
    const a = phases[i]
    const b = phases[i + dir]
    if (!a || !b) return
    try {
      await api.updatePhase(a.id, { sortOrder: b.sortOrder })
      await api.updatePhase(b.id, { sortOrder: a.sortOrder })
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const openAdd = () => {
    setForm({ name: '', short: '', laborCategory: 'install', dayFlow: false, mode: 'office' })
    setAdding(true)
  }
  const openEdit = (p: Phase) => {
    setForm({ name: p.name, short: p.short, laborCategory: p.laborCategory, dayFlow: p.dayFlow, mode: p.mode ?? 'install' })
    setEditing(p)
  }
  const save = async () => {
    setBusy(true)
    try {
      const body = { name: form.name.trim(), short: form.short.trim() || form.name.trim(), laborCategory: form.laborCategory, dayFlow: form.dayFlow, mode: form.mode }
      if (editing) await api.updatePhase(editing.id, body)
      else await api.addPhase(body)
      setAdding(false)
      setEditing(null)
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  // Steps are numbered within each mode's field day.
  const steps: Partial<Record<WorkMode, number>> = {}
  return (
    <Stack spacing={1.5}>
      {error && <Alert severity="error">{error}</Alert>}
      <Typography variant="body2" color="text.secondary">
        Each phase belongs to a work mode on the start screen (Install, Service, Office, Shop). Field-day steps are walked in this order with
        "Next", inside their own mode. Other phases are picked directly. The labor category decides which line of the Jetbuilt labor budget the
        hours count against.
      </Typography>
      <Box>
        <Button variant="contained" onClick={openAdd}>
          Add phase
        </Button>
      </Box>
      {phases.map((p, i) => {
        const active = p.active !== false
        const m: WorkMode = p.mode ?? 'install'
        const label = p.dayFlow && active ? `${MODE_INFO[m].label} step ${(steps[m] = (steps[m] ?? 0) + 1)}` : `${MODE_INFO[m].label} · picked`
        return (
          <Row key={p.id} dim={!active}>
            <Stack>
              <Button size="small" sx={{ minWidth: 0, p: 0, lineHeight: 1 }} disabled={i === 0} onClick={() => void move(i, -1)} aria-label={`Move ${p.name} up`}>
                ▲
              </Button>
              <Button size="small" sx={{ minWidth: 0, p: 0, lineHeight: 1 }} disabled={i === phases.length - 1} onClick={() => void move(i, 1)} aria-label={`Move ${p.name} down`}>
                ▼
              </Button>
            </Stack>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }} noWrap>
                {p.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" noWrap>
                {label} · {p.short}
              </Typography>
            </Box>
            <TextField select size="small" label="Mode" value={p.mode ?? 'install'} onChange={(e) => void update(p, { mode: e.target.value as WorkMode })} sx={{ width: 110 }}>
              {WORK_MODES.map((wm) => (
                <MenuItem key={wm} value={wm}>
                  {MODE_INFO[wm].label}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              select
              size="small"
              label="Counts as"
              value={p.laborCategory}
              onChange={(e) => void update(p, { laborCategory: e.target.value })}
              sx={{ width: 170 }}
            >
              {CATEGORIES.map((c) => (
                <MenuItem key={c.value} value={c.value}>
                  {c.label}
                </MenuItem>
              ))}
            </TextField>
            <FormControlLabel
              control={<Switch size="small" checked={p.dayFlow} onChange={() => void update(p, { dayFlow: !p.dayFlow })} />}
              label={<Typography variant="body2">Field-day step</Typography>}
            />
            <Button size="small" onClick={() => openEdit(p)}>
              Rename
            </Button>
            <Switch checked={active} onChange={() => void update(p, { active: !active })} inputProps={{ 'aria-label': `${p.name} offered to techs` }} />
          </Row>
        )
      })}

      <Dialog open={adding || Boolean(editing)} onClose={() => (setAdding(false), setEditing(null))} fullWidth maxWidth="xs">
        <DialogTitle>{editing ? 'Rename phase' : 'Add phase'}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} autoFocus />
            <TextField label="Short label" value={form.short} onChange={(e) => setForm({ ...form, short: e.target.value })} helperText="Shown on the step track and the board" />
            <TextField select label="Mode" value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value as WorkMode })} helperText="Which start-screen choice offers it">
              {WORK_MODES.map((wm) => (
                <MenuItem key={wm} value={wm}>
                  {MODE_INFO[wm].label}
                </MenuItem>
              ))}
            </TextField>
            <TextField select label="Counts as" value={form.laborCategory} onChange={(e) => setForm({ ...form, laborCategory: e.target.value })}>
              {CATEGORIES.map((c) => (
                <MenuItem key={c.value} value={c.value}>
                  {c.label}
                </MenuItem>
              ))}
            </TextField>
            <FormControlLabel
              control={<Checkbox checked={form.dayFlow} onChange={(e) => setForm({ ...form, dayFlow: e.target.checked })} />}
              label="Step of the field day (walked with Next)"
            />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => (setAdding(false), setEditing(null))}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={busy || !form.name.trim()}>
            {editing ? 'Save' : 'Add'}
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

// ─── Expense categories and mileage rate ───────────────────────────────────

function ExpenseSetup() {
  const { data, error, setError, load } = useLoader(() => api.expenseCategories(true))
  const [name, setName] = useState('')
  const [kind, setKind] = useState<'expense' | 'mileage'>('expense')
  const [rate, setRate] = useState('')
  const [reimb, setReimb] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  useEffect(() => {
    if (data && rate === '') setRate(String(data.mileageRate))
    if (data && reimb === null) setReimb(data.reimbursementAccountCode)
  }, [data, rate, reimb])
  const run = async (fn: () => Promise<unknown>, done = '') => {
    setNotice('')
    try {
      await fn()
      await load()
      if (done) setNotice(done)
    } catch (err) {
      setError(errorText(err))
    }
  }
  return (
    <Stack spacing={1.5}>
      <Typography variant="body2" color="text.secondary">
        What people can claim. Mileage categories are entered as miles and priced at the mileage rate. The account code is where accounting posts
        the line.
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity="success">{notice}</Alert>}
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <TextField size="small" label="Mileage rate ($ a mile)" type="number" inputProps={{ step: 0.005, min: 0 }} value={rate} onChange={(e) => setRate(e.target.value)} sx={{ width: 190 }} />
          <Button variant="outlined" onClick={() => void run(() => api.setMileageRate(Number(rate)), 'Mileage rate saved. It applies to new mileage lines.')}>
            Save rate
          </Button>
          <Typography variant="caption" color="text.secondary">
            IRS business rate for 2026: $0.725
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1, mt: 2 }}>
          <TextField size="small" label="Own-money lines post to" value={reimb ?? ''} onChange={(e) => setReimb(e.target.value)} placeholder="e.g. 6-1140" sx={{ width: 190 }} />
          <Button variant="outlined" onClick={() => void run(() => api.saveExpenseSettings({ reimbursementAccountCode: (reimb ?? '').trim() }), 'Saved. It applies to every line paid with the employee\u2019s own money.')}>
            Save
          </Button>
          <Typography variant="caption" color="text.secondary" sx={{ flex: '1 1 220px' }}>
            Lines paid with the employee&apos;s own money (mileage excepted) post here. Company-card lines and mileage use the category&apos;s account. Leave
            empty to use the category for everything.
          </Typography>
        </Stack>
      </Paper>
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField size="small" label="New category" value={name} onChange={(e) => setName(e.target.value)} sx={{ flex: 1 }} />
        <TextField select size="small" value={kind} onChange={(e) => setKind(e.target.value as 'expense' | 'mileage')} sx={{ width: 130 }}>
          <MenuItem value="expense">Amount</MenuItem>
          <MenuItem value="mileage">Mileage</MenuItem>
        </TextField>
        <Button
          variant="contained"
          disabled={!name.trim()}
          onClick={() =>
            void run(async () => {
              await api.addExpenseCategory({ name: name.trim(), kind })
              setName('')
            })
          }
        >
          Add
        </Button>
      </Stack>
      {(data?.data ?? []).map((c) => (
        <Row key={c.id} dim={!c.active}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600 }} noWrap>
              {c.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {c.kind === 'mileage' ? 'Miles × rate' : 'Amount'}
            </Typography>
          </Box>
          <TextField
            size="small"
            label="Account code"
            defaultValue={c.accountCode}
            onBlur={(e) => e.target.value.trim() !== c.accountCode && void run(() => api.updateExpenseCategory(c.id, { accountCode: e.target.value.trim() }))}
            sx={{ width: 140 }}
          />
          <Switch checked={c.active} onChange={() => void run(() => api.updateExpenseCategory(c.id, { active: !c.active }))} inputProps={{ 'aria-label': `${c.name} offered` }} />
        </Row>
      ))}
    </Stack>
  )
}

// ─── Service billing ────────────────────────────────────────────────────────
// How a service call is invoiced. Payroll always pays the real punched time.

function Billing() {
  const { data, error, setError, load } = useLoader(api.billingRules)
  const [form, setForm] = useState<{ travelHours: string; includedHours: string; incrementMinutes: string } | null>(null)
  const [saved, setSaved] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (data && !form) setForm({ travelHours: String(data.travelHours), includedHours: String(data.includedHours), incrementMinutes: String(data.incrementMinutes) })
  }, [data, form])
  if (!form) return error ? <Alert severity="error">{error}</Alert> : null
  const save = async () => {
    setBusy(true)
    setSaved(false)
    try {
      const rules: Partial<BillingRules> = { travelHours: Number(form.travelHours), includedHours: Number(form.includedHours), incrementMinutes: Number(form.incrementMinutes) }
      await api.saveBillingRules(rules)
      await load()
      setSaved(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={2} sx={{ maxWidth: 420 }}>
        <Typography variant="body2" color="text.secondary">
          Travel to a call is billed as a flat amount, the trip charge covers the first part of the visit, and time on site past that is billed in
          steps. The drive to the next call belongs to the next call. Techs are still paid their real drive and site time.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {saved && <Alert severity="success">Saved.</Alert>}
        <TextField label="Travel billed per call (hours)" type="number" inputProps={{ step: 0.25, min: 0 }} value={form.travelHours} onChange={(e) => setForm({ ...form, travelHours: e.target.value })} />
        <TextField label="Hours on site covered by the trip charge" type="number" inputProps={{ step: 0.25, min: 0 }} value={form.includedHours} onChange={(e) => setForm({ ...form, includedHours: e.target.value })} />
        <TextField label="Billing step after that (minutes)" type="number" inputProps={{ step: 5, min: 1 }} value={form.incrementMinutes} onChange={(e) => setForm({ ...form, incrementMinutes: e.target.value })} />
        <Box>
          <Button variant="contained" onClick={save} disabled={busy}>
            Save
          </Button>
        </Box>
      </Stack>
    </Paper>
  )
}

// ─── API keys ───────────────────────────────────────────────────────────────

function Keys() {
  const { data, error, setError, load } = useLoader(api.keys)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [scopes, setScopes] = useState<string[]>([])
  const [created, setCreated] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)

  const create = async () => {
    setBusy(true)
    try {
      const r = await api.createKey(name.trim(), scopes)
      setCreated(r.key)
      setAdding(false)
      setName('')
      setScopes([])
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const revoke = async (k: ApiKey) => {
    try {
      await api.revokeKey(k.id)
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return (
    <Stack spacing={1.5}>
      {error && <Alert severity="error">{error}</Alert>}
      <Typography variant="body2" color="text.secondary">
        One key per app that links to Time Tracking. A key can do only what its scopes allow, and can be revoked without touching the others.{' '}
        <a href="/api/v1/docs" target="_blank" rel="noreferrer">
          API reference
        </a>
      </Typography>
      <Box>
        <Button variant="contained" onClick={() => setAdding(true)}>
          Create key
        </Button>
      </Box>
      {(data?.data ?? []).map((k) => (
        <Row key={k.id} dim={Boolean(k.revokedAt)}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600 }} noWrap>
              {k.name}{' '}
              <Typography component="span" variant="body2" color="text.secondary" sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>
                {k.prefix}
              </Typography>
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {k.scopes.join(', ')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {k.revokedAt ? 'Revoked' : k.lastUsedAt ? `Last used ${new Date(k.lastUsedAt).toLocaleDateString()} ${fmtTime(k.lastUsedAt)}` : 'Never used'}
            </Typography>
          </Box>
          {!k.revokedAt && (
            <Button color="warning" onClick={() => void revoke(k)}>
              Revoke
            </Button>
          )}
        </Row>
      ))}

      <Dialog open={adding} onClose={() => setAdding(false)} fullWidth maxWidth="xs">
        <DialogTitle>Create key</DialogTitle>
        <DialogContent>
          <Stack spacing={1} sx={{ pt: 1 }}>
            <TextField label="Which app is this for?" placeholder="AIC Terminal" value={name} onChange={(e) => setName(e.target.value)} />
            <Typography variant="subtitle2" sx={{ pt: 1 }}>
              What it may do
            </Typography>
            {(data?.availableScopes ?? []).map((s) => (
              <FormControlLabel
                key={s}
                control={<Checkbox size="small" checked={scopes.includes(s)} onChange={(e) => setScopes(e.target.checked ? [...scopes, s] : scopes.filter((x) => x !== s))} />}
                label={<Typography variant="body2" sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{s}</Typography>}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)}>Cancel</Button>
          <Button variant="contained" onClick={create} disabled={busy || !name.trim() || scopes.length === 0}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(created)} fullWidth maxWidth="sm">
        <DialogTitle>Copy this key now</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Alert severity="warning">This is the only time the key is shown. Put it in the other app's settings, not in an email or chat.</Alert>
            <Paper sx={{ p: 1.5, fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all', bgcolor: 'grey.100' }}>{created}</Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={copy}>{copied ? 'Copied' : 'Copy'}</Button>
          <Button
            variant="contained"
            onClick={() => {
              setCreated('')
              setCopied(false)
            }}
          >
            Done
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}
