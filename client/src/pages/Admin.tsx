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
import { api, errorText, fmtTime, grabGeo, type ApiKey, type Company, type Job, type Person, type Webhook } from '../api'

// People, jobs and integration keys. Most jobs arrive from GED through the API;
// this page is for the ones added by hand and for seeing what is there.

type Section = 'people' | 'jobs' | 'company' | 'keys' | 'webhooks'

export default function AdminPage({ me }: { me: Person }) {
  const isAdmin = me.scopes.includes('keys:manage')
  const [section, setSection] = useState<Section>('people')
  return (
    <Stack spacing={2}>
      <Tabs value={section} onChange={(_, v: Section) => setSection(v)} variant="scrollable" allowScrollButtonsMobile>
        <Tab value="people" label="People" />
        <Tab value="jobs" label="Jobs" />
        {isAdmin && <Tab value="company" label="Company" />}
        {isAdmin && <Tab value="keys" label="API keys" />}
        {isAdmin && <Tab value="webhooks" label="Webhooks" />}
      </Tabs>
      {section === 'people' && <People isAdmin={isAdmin} />}
      {section === 'jobs' && <Jobs />}
      {section === 'company' && isAdmin && <CompanySettings />}
      {section === 'keys' && isAdmin && <Keys />}
      {section === 'webhooks' && isAdmin && <Webhooks />}
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
  const [siteJob, setSiteJob] = useState<Job | null>(null)

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
          <Button size="small" onClick={() => setSiteJob(j)} title="Where the job site is, for the off-site check">
            {j.siteLat !== null && j.siteLat !== undefined ? 'Site set' : 'Set site'}
          </Button>
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

      {siteJob && (
        <PinDialog
          title={`Job site: ${siteJob.name}`}
          help="Punches for work phases that start farther than this from the pin are flagged for review. Travel phases are not checked."
          lat={siteJob.siteLat ?? null}
          lng={siteJob.siteLng ?? null}
          radiusM={siteJob.siteRadiusM ?? 200}
          onClose={() => setSiteJob(null)}
          onSave={async (v) => {
            await api.saveJob(siteJob.id, { siteLat: v.lat, siteLng: v.lng, siteRadiusM: v.lat === null ? null : v.radiusM })
            setSiteJob(null)
            await load()
          }}
        />
      )}
    </Stack>
  )
}

// ─── A pin and a radius: job sites and the shop ─────────────────────────────

function PinDialog({
  title,
  help,
  lat,
  lng,
  radiusM,
  onClose,
  onSave,
}: {
  title: string
  help: string
  lat: number | null
  lng: number | null
  radiusM: number
  onClose: () => void
  onSave: (v: { lat: number | null; lng: number | null; radiusM: number }) => Promise<void>
}) {
  const [form, setForm] = useState({ lat: lat === null ? '' : String(lat), lng: lng === null ? '' : String(lng), radius: String(radiusM) })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const here = async () => {
    setBusy(true)
    const g = await grabGeo(10_000)
    setBusy(false)
    if (!g) return setError('This device did not give a location. Allow location for this site, or type the numbers.')
    setForm({ ...form, lat: g.lat.toFixed(6), lng: g.lng.toFixed(6) })
    setError('')
  }
  const paste = (v: string) => {
    // Accept "47.8123, -122.3045" pasted from a map into either box.
    const m = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(v)
    if (m) setForm({ ...form, lat: m[1], lng: m[2] })
    return Boolean(m)
  }
  const save = async (clear = false) => {
    setBusy(true)
    setError('')
    try {
      const la = clear || form.lat.trim() === '' ? null : Number(form.lat)
      const ln = clear || form.lng.trim() === '' ? null : Number(form.lng)
      if ((la === null) !== (ln === null) || (la !== null && (!Number.isFinite(la) || !Number.isFinite(ln)))) throw new Error('Give both latitude and longitude as numbers.')
      await onSave({ lat: la, lng: ln, radiusM: Number(form.radius) || 200 })
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {help} Standing there? Use this phone's location. Otherwise paste the coordinates from Google Maps (right-click the spot).
          </Typography>
          <Button variant="outlined" onClick={() => void here()} disabled={busy}>
            Use my location
          </Button>
          <TextField label="Latitude" value={form.lat} onChange={(e) => paste(e.target.value) || setForm({ ...form, lat: e.target.value })} inputMode="decimal" />
          <TextField label="Longitude" value={form.lng} onChange={(e) => paste(e.target.value) || setForm({ ...form, lng: e.target.value })} inputMode="decimal" />
          <TextField label="Radius (metres)" value={form.radius} onChange={(e) => setForm({ ...form, radius: e.target.value })} inputMode="numeric" helperText="200 m suits most sites; a campus may need more" />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {lat !== null && (
          <Button color="warning" onClick={() => void save(true)} disabled={busy} sx={{ mr: 'auto' }}>
            Remove pin
          </Button>
        )}
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Company settings ───────────────────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function CompanySettings() {
  const { data, error, setError, load } = useLoader(api.company)
  const [saved, setSaved] = useState('')
  const [pin, setPin] = useState(false)

  const save = async (body: Partial<Omit<Company, 'id' | 'weekStartName'>>, what: string) => {
    setSaved('')
    try {
      await api.saveCompany(body)
      await load()
      setSaved(what)
    } catch (err) {
      setError(errorText(err))
    }
  }

  if (!data) return error ? <Alert severity="error">{error}</Alert> : null
  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      {saved && <Alert severity="success">{saved} saved.</Alert>}
      <Paper sx={{ p: 2 }}>
        <Stack spacing={2}>
          <TextField
            select
            label="Week starts on"
            value={data.weekStartDay}
            onChange={(e) => void save({ weekStartDay: Number(e.target.value) }, 'Week start')}
            helperText="The week techs sign and managers approve. Match your payroll week."
          >
            {DAYS.map((d, i) => (
              <MenuItem key={d} value={i}>
                {d}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Timezone" value={data.timezone} disabled helperText="Days and weeks are counted in this timezone" />
        </Stack>
      </Paper>
      <Paper sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Typography sx={{ fontWeight: 600 }}>Shop location</Typography>
            <Typography variant="body2" color="text.secondary">
              {data.shopLat !== null ? `${data.shopLat.toFixed(5)}, ${data.shopLng?.toFixed(5)} · ${data.shopRadiusM} m` : 'Not set. Shop phases are not checked for location.'}
            </Typography>
          </Box>
          <Button onClick={() => setPin(true)}>{data.shopLat !== null ? 'Change' : 'Set'}</Button>
        </Stack>
      </Paper>
      {pin && (
        <PinDialog
          title="Shop location"
          help="Shop phases (load, put away) that start farther than this from the shop are flagged for review, and the board shows who is at the shop."
          lat={data.shopLat}
          lng={data.shopLng}
          radiusM={data.shopRadiusM}
          onClose={() => setPin(false)}
          onSave={async (v) => {
            await api.saveCompany({ shopLat: v.lat, shopLng: v.lng, shopRadiusM: v.radiusM })
            setPin(false)
            await load()
            setSaved('Shop location')
          }}
        />
      )}
    </Stack>
  )
}

// ─── Webhooks ───────────────────────────────────────────────────────────────

function Webhooks() {
  const { data, error, setError, load } = useLoader(api.webhooks)
  const [adding, setAdding] = useState(false)
  const [url, setUrl] = useState('')
  const [events, setEvents] = useState<string[]>([])
  const [secret, setSecret] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setNotice('')
    try {
      await fn()
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Stack spacing={1.5}>
      {error && <Alert severity="error">{error}</Alert>}
      {notice && <Alert severity={notice.startsWith('Delivered') ? 'success' : 'warning'}>{notice}</Alert>}
      <Typography variant="body2" color="text.secondary">
        For apps that accept incoming calls. Each change is sent to the address, signed with its secret, and retried for 24 hours. Apps that cannot accept calls, like GED, read the change feed instead.
      </Typography>
      <Box>
        <Button variant="contained" onClick={() => setAdding(true)}>
          Add webhook
        </Button>
      </Box>
      {(data?.data ?? []).map((w: Webhook) => (
        <Row key={w.id} dim={!w.active}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 600, wordBreak: 'break-all' }}>{w.url}</Typography>
            <Typography variant="body2" color="text.secondary">
              {w.events.length ? w.events.join(', ') : 'Every event'}
            </Typography>
            <Typography variant="caption" color={w.failed ? 'warning.main' : 'text.secondary'}>
              {w.delivered} delivered · {w.pending} waiting · {w.failed} failed
            </Typography>
          </Box>
          <Stack spacing={0.5}>
            <Button
              size="small"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const r = await api.testWebhook(w.id)
                  setNotice(r.ok ? `Delivered (HTTP ${r.code}).` : `Not delivered: ${r.error || `HTTP ${r.code}`}`)
                })
              }
            >
              Test
            </Button>
            {w.failed > 0 && (
              <Button size="small" disabled={busy} onClick={() => void run(() => api.retryWebhook(w.id))}>
                Retry failed
              </Button>
            )}
            <Button size="small" color="warning" disabled={busy} onClick={() => void run(() => api.deleteWebhook(w.id))}>
              Remove
            </Button>
          </Stack>
          <Switch checked={w.active} onChange={() => void run(() => api.setWebhookActive(w.id, !w.active))} inputProps={{ 'aria-label': 'Sending' }} />
        </Row>
      ))}

      <Dialog open={adding} onClose={() => setAdding(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add webhook</DialogTitle>
        <DialogContent>
          <Stack spacing={1} sx={{ pt: 1 }}>
            <TextField label="Address" placeholder="https://example.com/hooks/time" value={url} onChange={(e) => setUrl(e.target.value)} />
            <Typography variant="subtitle2" sx={{ pt: 1 }}>
              Which events (none ticked = all)
            </Typography>
            {(data?.eventTypes ?? []).map((t) => (
              <FormControlLabel
                key={t}
                control={<Checkbox size="small" checked={events.includes(t)} onChange={(e) => setEvents(e.target.checked ? [...events, t] : events.filter((x) => x !== t))} />}
                label={<Typography variant="body2" sx={{ fontFamily: 'ui-monospace, Consolas, monospace' }}>{t}</Typography>}
              />
            ))}
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAdding(false)}>Cancel</Button>
          <Button
            variant="contained"
            disabled={busy || !url.trim()}
            onClick={() =>
              void run(async () => {
                const r = await api.addWebhook(url.trim(), events)
                setSecret(r.secret)
                setAdding(false)
                setUrl('')
                setEvents([])
              })
            }
          >
            Add
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(secret)} fullWidth maxWidth="sm">
        <DialogTitle>Copy the signing secret now</DialogTitle>
        <DialogContent>
          <Stack spacing={2}>
            <Alert severity="warning">This is the only time it is shown. The receiving app uses it to check the X-TT-Signature header.</Alert>
            <Paper sx={{ p: 1.5, fontFamily: 'ui-monospace, Consolas, monospace', wordBreak: 'break-all', bgcolor: 'grey.100' }}>{secret}</Paper>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button variant="contained" onClick={() => setSecret('')}>
            Done
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
