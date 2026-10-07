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
import { api, errorText, fmtTime, type ApiKey, type Job, type Person } from '../api'

// People, jobs and integration keys. Most jobs arrive from GED through the API;
// this page is for the ones added by hand and for seeing what is there.

type Section = 'people' | 'jobs' | 'keys'

export default function AdminPage({ me }: { me: Person }) {
  const isAdmin = me.scopes.includes('keys:manage')
  const [section, setSection] = useState<Section>('people')
  return (
    <Stack spacing={2}>
      <Tabs value={section} onChange={(_, v: Section) => setSection(v)}>
        <Tab value="people" label="People" />
        <Tab value="jobs" label="Jobs" />
        {isAdmin && <Tab value="keys" label="API keys" />}
      </Tabs>
      {section === 'people' && <People isAdmin={isAdmin} />}
      {section === 'jobs' && <Jobs />}
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
                helperText="At least 10 characters. Leave blank if they sign in from GED"
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
              {['project', 'service', 'shop', 'other'].map((k) => (
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
