// TESTED & APPROVED by Art 2026-11-07: (part) per-person Password button and dialog in Manage > People. See TESTED.md before changing.
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import PasswordField from '../PasswordField'
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
import { api, errorText, fmtTime, WORK_MODES, type ApiKey, type BillingRules, type Job, type Person, type Phase, type WorkerType, type WorkMode } from '../api'
import { MODE_INFO } from './modes'

/** Days without time before a project that is not won folds under Archived (matches the server's jobArchive.ts). */
const RECENT_DAYS = 60

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
  }, [fn])
  useEffect(() => {
    void load()
  }, [load])
  return { data, error, setError, load }
}

const allExpenseCategories = () => api.expenseCategories(true)

const Row = ({ children, dim }: { children: ReactNode; dim?: boolean }) => (
  <Paper sx={{ p: 1.5, opacity: dim ? 0.55 : 1 }}>
    <Stack direction="row" spacing={1.5} alignItems="center">
      {children}
    </Stack>
  </Paper>
)

// ─── People ─────────────────────────────────────────────────────────────────

const ROLES: Person['role'][] = ['tech', 'sales', 'lead', 'shop_supervisor', 'manager', 'payroll', 'admin', 'division_admin']
// Only a signed-in admin hands these out (the server checks too).
const GUARDED: Person['role'][] = ['admin', 'division_admin']
const ROLE_TEXT: Partial<Record<Person['role'], string>> = { division_admin: 'division admin', shop_supervisor: 'shop supervisor' }
const roleText = (r: Person['role']) => ROLE_TEXT[r] ?? r

// W-2 employee or 1099 contractor. Shown only when the server has CONTRACTORS_ENABLED.
const WORKER_LABEL: Record<WorkerType, string> = { employee: 'W-2', contractor: '1099' }
const WORKER_TEXT: Record<WorkerType, string> = { employee: 'W-2 employee', contractor: '1099 contractor' }

function People({ isAdmin }: { isAdmin: boolean }) {
  const { data: roster, error, setError, load } = useLoader(api.roster)
  const data = roster?.people
  const contractors = roster?.contractorsEnabled ?? false
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState({ email: '', name: '', initials: '', role: 'tech', division: '', password: '', workerType: 'employee' as WorkerType })
  // Role and division of someone already on the roster (signed-in admins only).
  const [roleFor, setRoleFor] = useState<{ person: Person; role: Person['role']; division: string; salaried: boolean; error: string } | null>(null)
  const divisions = [...new Set((data ?? []).map((p) => p.division ?? '').filter(Boolean))].sort()
  const [busy, setBusy] = useState(false)
  const [payAs, setPayAs] = useState<{ person: Person; workerType: WorkerType; from: string } | null>(null)
  const [pwFor, setPwFor] = useState<{ person: Person; password: string; mustChange: boolean; saved: boolean; error: string } | null>(null)

  // Set or replace someone's password (signed-in admins only). Sends only the
  // password, so name, initials and role stay as they are. By default they must
  // pick their own at their next sign-in.
  const savePassword = async () => {
    if (!pwFor) return
    setBusy(true)
    try {
      await api.savePerson(pwFor.person.email, { password: pwFor.password, mustChangePassword: pwFor.mustChange })
      void load()
      setPwFor({ ...pwFor, saved: true, error: '' })
    } catch (err) {
      setPwFor({ ...pwFor, error: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  const savePayAs = async () => {
    if (!payAs) return
    setBusy(true)
    try {
      await api.savePerson(payAs.person.email, { workerType: payAs.workerType, workerTypeFrom: payAs.from || null })
      setPayAs(null)
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    setBusy(true)
    try {
      await api.savePerson(form.email.trim(), {
        name: form.name.trim(),
        initials: form.initials.trim(),
        role: form.role,
        ...(isAdmin && form.division.trim() ? { division: form.division.trim() } : {}),
        password: form.password || undefined,
        ...(contractors ? { workerType: form.workerType } : {}),
      })
      setAdding(false)
      setForm({ email: '', name: '', initials: '', role: 'tech', division: '', password: '', workerType: 'employee' })
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const saveRole = async () => {
    if (!roleFor) return
    setBusy(true)
    try {
      await api.savePerson(roleFor.person.email, { role: roleFor.role, division: roleFor.division.trim(), overtimeExempt: roleFor.salaried })
      setRoleFor(null)
      await load()
    } catch (err) {
      setRoleFor({ ...roleFor, error: errorText(err) })
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
          {contractors && (
            <Chip
              size="small"
              variant={p.workerType === 'contractor' ? 'filled' : 'outlined'}
              color={p.workerType === 'contractor' ? 'warning' : 'default'}
              label={WORKER_LABEL[p.workerType ?? 'employee']}
              onClick={() => setPayAs({ person: p, workerType: p.workerType ?? 'employee', from: p.workerTypeFrom ?? '' })}
              aria-label={`${p.name} is paid as ${WORKER_TEXT[p.workerType ?? 'employee']}. Change`}
            />
          )}
          {p.mustChangePassword && <Chip size="small" color="info" variant="outlined" label="New password due" title="They must pick their own password at their next sign-in" />}
          {p.division && <Chip size="small" variant="outlined" label={p.division} />}
          {p.overtimeExempt && <Chip size="small" variant="outlined" label="Salaried" title="No weekly overtime: all their hours go to payroll as regular" />}
          <Chip
            size="small"
            label={roleText(p.role)}
            onClick={isAdmin ? () => setRoleFor({ person: p, role: p.role, division: p.division ?? '', salaried: Boolean(p.overtimeExempt), error: '' }) : undefined}
            aria-label={isAdmin ? `${p.name} is ${roleText(p.role)}. Change role, division or salaried` : undefined}
          />
          {isAdmin && (
            <Button size="small" onClick={() => setPwFor({ person: p, password: '', mustChange: true, saved: false, error: '' })} aria-label={`Set a password for ${p.name}`}>
              Password
            </Button>
          )}
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
              {ROLES.filter((r) => isAdmin || !GUARDED.includes(r)).map((r) => (
                <MenuItem key={r} value={r}>
                  {roleText(r)}
                </MenuItem>
              ))}
            </TextField>
            {isAdmin && (
              <TextField
                label="Division"
                value={form.division}
                onChange={(e) => setForm({ ...form, division: e.target.value })}
                helperText={form.role === 'division_admin' ? 'They manage only the people in this division' : 'Optional, e.g. Sound Services'}
              />
            )}
            {contractors && (
              <TextField select label="Paid as" value={form.workerType} onChange={(e) => setForm({ ...form, workerType: e.target.value as WorkerType })}>
                {(['employee', 'contractor'] as const).map((t) => (
                  <MenuItem key={t} value={t}>
                    {WORKER_TEXT[t]}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {isAdmin && (
              <PasswordField
                label="Starting password"
                autoComplete="new-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                onGenerate={(password) => setForm({ ...form, password })}
                helperText="At least 10 characters. They pick their own at first sign-in. Leave blank if they sign in from GED"
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

      <Dialog open={Boolean(roleFor)} onClose={() => setRoleFor(null)} fullWidth maxWidth="xs">
        <DialogTitle>Role, division and pay: {roleFor?.person.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            {roleFor?.error && <Alert severity="error">{roleFor.error}</Alert>}
            <TextField select label="Role" value={roleFor?.role ?? 'tech'} onChange={(e) => roleFor && setRoleFor({ ...roleFor, role: e.target.value as Person['role'] })}>
              {ROLES.map((r) => (
                <MenuItem key={r} value={r}>
                  {roleText(r)}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              label="Division"
              value={roleFor?.division ?? ''}
              onChange={(e) => roleFor && setRoleFor({ ...roleFor, division: e.target.value })}
              inputProps={{ list: 'logbook-divisions' }}
              helperText={
                roleFor?.role === 'division_admin'
                  ? 'They see and manage only the people in this division: timecards, time fixes, leave, reports and the payroll export.'
                  : 'e.g. Sound Services. Leave empty for none.'
              }
            />
            <datalist id="logbook-divisions">
              {divisions.map((d) => (
                <option key={d} value={d} />
              ))}
            </datalist>
            {roleFor?.role === 'division_admin' && !roleFor.division.trim() && <Alert severity="warning">A division admin with no division sees nobody.</Alert>}
            <FormControlLabel
              control={<Switch checked={roleFor?.salaried ?? false} onChange={(e) => roleFor && setRoleFor({ ...roleFor, salaried: e.target.checked })} />}
              label="Salaried: no weekly overtime"
            />
            <Typography variant="body2" color="text.secondary">
              Salaried staff get no overtime. All their hours go to payroll as regular hours. Leave it off for hourly people.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRoleFor(null)}>Cancel</Button>
          <Button variant="contained" disabled={busy} onClick={() => void saveRole()}>
            Save
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(pwFor)} onClose={() => setPwFor(null)} fullWidth maxWidth="xs">
        <DialogTitle>Password for {pwFor?.person.name}</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              {pwFor?.person.email}. This replaces any password they have now.
            </Typography>
            <PasswordField
              label="New password"
              autoComplete="new-password"
              value={pwFor?.password ?? ''}
              onChange={(e) => pwFor && setPwFor({ ...pwFor, password: e.target.value, saved: false })}
              onGenerate={(password) => pwFor && setPwFor({ ...pwFor, password, saved: false, error: '' })}
              helperText="At least 10 characters"
            />
            <FormControlLabel
              control={<Checkbox checked={pwFor?.mustChange ?? true} disabled={pwFor?.saved} onChange={(e) => pwFor && setPwFor({ ...pwFor, mustChange: e.target.checked })} />}
              label={<Typography variant="body2">They must pick their own password at their next sign-in</Typography>}
            />
            {pwFor?.saved && <Alert severity="success">Saved. Copy it now to give to {pwFor.person.name}; it is not shown again after you close this.</Alert>}
            {pwFor?.error && <Alert severity="error">{pwFor.error}</Alert>}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPwFor(null)}>{pwFor?.saved ? 'Done' : 'Cancel'}</Button>
          {!pwFor?.saved && (
            <Button variant="contained" onClick={savePassword} disabled={busy || (pwFor?.password.length ?? 0) < 10}>
              Save password
            </Button>
          )}
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(payAs)} onClose={() => setPayAs(null)} fullWidth maxWidth="xs">
        <DialogTitle>How {payAs?.person.name} is paid</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField select label="Paid as" value={payAs?.workerType ?? 'employee'} onChange={(e) => payAs && setPayAs({ ...payAs, workerType: e.target.value as WorkerType })}>
              {(['employee', 'contractor'] as const).map((t) => (
                <MenuItem key={t} value={t}>
                  {WORKER_TEXT[t]}
                </MenuItem>
              ))}
            </TextField>
            <TextField
              type="date"
              label="Starting"
              value={payAs?.from ?? ''}
              onChange={(e) => payAs && setPayAs({ ...payAs, from: e.target.value })}
              InputLabelProps={{ shrink: true }}
              helperText="Hours from this day are paid this way. Leave blank for today when changing; days before it keep the old way."
            />
            <Typography variant="body2" color="text.secondary">
              1099 contractors punch and log expenses as usual. Their hours go to payroll marked 1099, with no overtime and no sick or vacation
              leave, and AIC Accounting pays them as a vendor with no withholding.
            </Typography>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPayAs(null)}>Cancel</Button>
          <Button variant="contained" onClick={savePayAs} disabled={busy}>
            Save
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

// ─── Jobs ───────────────────────────────────────────────────────────────────

// Open jobs on top; old projects and jobs closed to new time under Archived, in the
// same list (Art, 2026-11-09). Archived is folded until opened. Nothing is deleted.
function Jobs() {
  const { data, error, setError, load } = useLoader(api.allJobs)
  const [adding, setAdding] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
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
  const all = data ?? []
  const open = all.filter((j) => !j.archived)
  const archived = all.filter((j) => j.archived)
  const lastTime = (j: Job) => (j.lastPunchAt ? `last time ${new Date(j.lastPunchAt).toLocaleDateString()}` : '')
  const jobRow = (j: Job) => (
    <Row key={j.id} dim={!j.active}>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontWeight: 600 }} noWrap>
          {j.name}
        </Typography>
        <Typography variant="body2" color="text.secondary" noWrap>
          {[j.code, j.stage ? j.stage.toLowerCase() : '', ...(j.refs ?? []).map((r) => `${r.system}: ${r.externalId}`), lastTime(j)].filter(Boolean).join(' · ') ||
            'Added by hand'}
        </Typography>
      </Box>
      <Chip size="small" label={j.kind} />
      <Switch checked={j.active} onChange={() => void toggle(j)} inputProps={{ 'aria-label': `${j.name} open for time` }} />
    </Row>
  )

  return (
    <Stack spacing={1.5}>
      {error && <Alert severity="error">{error}</Alert>}
      <AddedByTechs onChange={() => void load()} />
      <Box>
        <Button variant="contained" onClick={() => setAdding(true)}>
          Add job
        </Button>
      </Box>
      {open.map(jobRow)}
      {open.length === 0 && data && (
        <Typography variant="body2" color="text.secondary">
          No open jobs.
        </Typography>
      )}

      {archived.length > 0 && (
        <>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ pt: 1 }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 600, flex: 1 }}>
              Archived ({archived.length})
            </Typography>
            <Button size="small" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? 'Hide' : 'Show'}
            </Button>
          </Stack>
          {showArchived && (
            <>
              <Typography variant="body2" color="text.secondary">
                Projects that are not at Contract, Install or Review in Jetbuilt and have had no time in {RECENT_DAYS} days, and jobs switched off. Hours on them
                are kept. A switched-on job here can still be picked under Archived projects on the punch screen.
              </Typography>
              {archived.map(jobRow)}
            </>
          )}
        </>
      )}

      <Dialog open={adding} onClose={() => setAdding(false)} fullWidth maxWidth="xs">
        <DialogTitle>Add job</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <TextField label="Number or code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} helperText="P-number, service ticket…" />
            <TextField select label="Kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {['project', 'service', 'visit', 'shop', 'repair', 'other'].map((k) => (
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

// Clients a tech added from the punch screen (Service Call or Site Visit). The office
// checks each one (puts it in Jetbuilt / AccountEdge, fixes the code or name) and
// marks it checked. Projects themselves come from Jetbuilt through GED.
function AddedByTechs({ onChange }: { onChange: () => void }) {
  const [showAll, setShowAll] = useState(false)
  const loader = useCallback(() => api.addedJobs(showAll ? 'all' : 'review'), [showAll])
  const { data, error, setError, load } = useLoader(loader)
  const [editing, setEditing] = useState<Job | null>(null)
  const [busy, setBusy] = useState(false)

  const mark = async (j: Job, reviewed: boolean, patch: Parameters<typeof api.updateJob>[1] = {}) => {
    setBusy(true)
    try {
      await api.updateJob(j.id, { ...patch, reviewed })
      setEditing(null)
      await load()
      onChange()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const rows = data ?? []
  if (!showAll && !rows.length && !error) {
    return (
      <Typography variant="body2" color="text.secondary">
        No new clients from techs waiting for a check.{' '}
        <Button size="small" onClick={() => setShowAll(true)}>
          Show all added by techs
        </Button>
      </Typography>
    )
  }
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderColor: rows.some((j) => !j.reviewedAt) ? 'warning.main' : undefined }}>
      <Stack spacing={1}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700, flex: 1 }}>
            New clients added by techs{rows.filter((j) => !j.reviewedAt).length ? ` (${rows.filter((j) => !j.reviewedAt).length} to check)` : ''}
          </Typography>
          <Button size="small" onClick={() => setShowAll((v) => !v)}>
            {showAll ? 'Only unchecked' : 'Show all'}
          </Button>
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {rows.map((j) => (
          <Row key={j.id} dim={!!j.reviewedAt}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }}>
                {j.clientName || j.name} <Chip size="small" label={j.kind === 'visit' ? 'Site visit' : 'Service call'} sx={{ ml: 0.5 }} />
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {[j.siteAddress, j.contactName, j.contactPhone, j.contactEmail].filter(Boolean).join(' · ')}
              </Typography>
              <Typography variant="caption" color="text.secondary">
                {j.code} · added by {j.addedBy?.name ?? 'a tech'}
                {j.createdAt ? ` on ${new Date(j.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : ''}
                {j.reviewedAt ? ' · checked' : ''}
              </Typography>
            </Box>
            <Button size="small" onClick={() => setEditing(j)} disabled={busy}>
              Edit
            </Button>
            <Button size="small" variant={j.reviewedAt ? 'text' : 'contained'} onClick={() => void mark(j, !j.reviewedAt)} disabled={busy}>
              {j.reviewedAt ? 'Uncheck' : 'Mark checked'}
            </Button>
          </Row>
        ))}
      </Stack>
      {editing && <EditAddedJob job={editing} busy={busy} onClose={() => setEditing(null)} onSave={(patch) => void mark(editing, true, patch)} />}
    </Paper>
  )
}

function EditAddedJob({ job, busy, onClose, onSave }: { job: Job; busy: boolean; onClose: () => void; onSave: (patch: Parameters<typeof api.updateJob>[1]) => void }) {
  const [f, setF] = useState({
    name: job.name,
    code: job.code,
    clientName: job.clientName ?? '',
    siteAddress: job.siteAddress ?? '',
    contactName: job.contactName ?? '',
    contactPhone: job.contactPhone ?? '',
    contactEmail: job.contactEmail ?? '',
  })
  const field = (k: keyof typeof f, label: string, helper?: string) => (
    <TextField label={label} value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} helperText={helper} />
  )
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Check new client</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {field('name', 'Name in Logbook')}
          {field('code', 'Number or code', 'Put the service ticket or Jetbuilt number here once it has one')}
          {field('clientName', 'Client')}
          {field('siteAddress', 'Address')}
          {field('contactName', 'Contact person')}
          {field('contactPhone', 'Phone')}
          {field('contactEmail', 'Email')}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !f.name.trim()} onClick={() => onSave(f)}>
          Save and mark checked
        </Button>
      </DialogActions>
    </Dialog>
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

/** Bench Repair: plain clock in / clock out, or the full version with repair tickets and tasks. */
function BenchSwitch() {
  const [on, setOn] = useState<boolean | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api.benchSettings().then((r) => setOn(r.clockOnly), (err) => setError(errorText(err)))
  }, [])
  const flip = async () => {
    try {
      setOn((await api.saveBenchSettings(!on)).clockOnly)
    } catch (err) {
      setError(errorText(err))
    }
  }
  if (on === null) return error ? <Alert severity="error">{error}</Alert> : null
  return (
    <Paper sx={{ p: 2 }}>
      <FormControlLabel control={<Switch checked={on} onChange={() => void flip()} />} label={<Typography sx={{ fontWeight: 600 }}>Bench Repair: clock in and clock out only</Typography>} />
      <Typography variant="body2" color="text.secondary">
        {on
          ? 'On: Bench Repair is one Clock In and one Clock Out button. Time goes to the Bench Repair job; no tickets or tasks are asked for.'
          : 'Off: bench techs pick the SD repair ticket and a task (Diagnose, Repair, Test, Parts), and the hours post to that ticket\u2019s SD invoice in AV Inventory.'}
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
    </Paper>
  )
}

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
      <BenchSwitch />
      <Typography variant="body2" color="text.secondary">
        Each phase belongs to a work mode on the start screen (Install, Service, Office, Shop, CAD, Bench Repair). Field-day steps are walked in this order with
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
  const { data, error, setError, load } = useLoader(allExpenseCategories)
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
            <TextField label="Which app is this for?" placeholder="GED" value={name} onChange={(e) => setName(e.target.value)} />
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
