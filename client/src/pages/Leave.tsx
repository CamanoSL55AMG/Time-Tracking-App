import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
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
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Tabs,
  TextField,
  Typography,
} from '@mui/material'
import {
  api,
  errorText,
  fmtDay,
  type AccrualRun,
  type ImportBody,
  type ImportMapping,
  type ImportPreview,
  type LeaveBalance,
  type LeavePolicy,
  type LeaveRequest,
  type LeaveSettings,
  type LeaveTeam,
  type LeaveType,
  type MyLeave,
} from '../api'

// Time off (TIME-TRACKING-APP.md §7). Shown only when the server has LEAVE_ENABLED on.
// Mine: balances, the sick-leave notice, asking for time off. Approve: managers, admin
// and payroll decide requests (never their own; crew leads don't decide). Team: who
// has what. Set up: policies, hire dates, accrual runs and the opening-balance import.

type Section = 'mine' | 'approve' | 'team' | 'setup'

const h = (n: number) => `${Number(n).toFixed(2).replace(/\.00$/, '')} h`
const span = (r: { startDate: string; endDate: string }) => (r.startDate === r.endDate ? fmtDay(r.startDate) : `${fmtDay(r.startDate)} to ${fmtDay(r.endDate)}`)
const STATUS_COLOR: Record<string, 'default' | 'success' | 'warning' | 'error'> = { pending: 'warning', approved: 'success', denied: 'error', cancelled: 'default' }
const STATUS_TEXT: Record<string, string> = { pending: 'Waiting', approved: 'Approved', denied: 'Not approved', cancelled: 'Cancelled' }

export default function LeavePage({ me, scopes }: { me: { id: string; name: string }; scopes: string[] }) {
  const can = (s: string) => scopes.includes(s)
  const sections: { key: Section; label: string; show: boolean }[] = [
    { key: 'mine', label: 'Mine', show: can('punch:self') },
    { key: 'approve', label: 'Approve', show: can('leave:approve') },
    { key: 'team', label: 'Team', show: can('leave:read') },
    { key: 'setup', label: 'Set up', show: can('leave:write') },
  ]
  const shown = sections.filter((s) => s.show)
  const [section, setSection] = useState<Section>(shown[0]?.key ?? 'mine')
  if (!shown.length) return <Alert severity="info">Time off is not on for your sign-in.</Alert>
  return (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>
        Time off
      </Typography>
      {shown.length > 1 && (
        <Tabs value={section} onChange={(_, v: Section) => setSection(v)} variant="scrollable" allowScrollButtonsMobile>
          {shown.map((s) => (
            <Tab key={s.key} value={s.key} label={s.label} />
          ))}
        </Tabs>
      )}
      {section === 'mine' && <Mine meId={me.id} />}
      {section === 'approve' && <Approve meId={me.id} />}
      {section === 'team' && <Team meId={me.id} canWrite={can('leave:write')} canRecord={can('leave:approve')} />}
      {section === 'setup' && <Setup />}
    </Stack>
  )
}

// ─── Mine ───────────────────────────────────────────────────────────────────

function Mine({ meId }: { meId: string }) {
  const [data, setData] = useState<MyLeave | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => api.myLeave().then(setData, (e) => setError(errorText(e))), [])
  useEffect(() => void load(), [load])
  if (!data) return error ? <Alert severity="error">{error}</Alert> : <CircularProgress />
  const typeOf = (id: string) => data.types.find((t) => t.id === id)
  const cancel = async (r: LeaveRequest) => {
    try {
      await api.cancelLeave(r.id)
      await load()
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Stack spacing={2}>
      {!data.noticeAckAt && data.types.some((t) => t.statutory === 'wa_sick') && <SickNotice onDone={load} />}
      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
        {data.balances.map((b) => (
          <BalanceCard key={b.leaveTypeId} type={typeOf(b.leaveTypeId)} b={b} />
        ))}
      </Stack>
      <RequestForm types={data.types.filter((t) => t.requestable !== false)} onDone={load} personId={meId} />
      {error && <Alert severity="error">{error}</Alert>}
      <Typography variant="subtitle2" color="text.secondary">
        My requests
      </Typography>
      {data.requests.length === 0 && <Typography color="text.secondary">None yet.</Typography>}
      {data.requests.map((r) => (
        <RequestRow key={r.id} r={r} action={(r.status === 'pending' || (r.status === 'approved' && r.startDate > data.today)) && <Button onClick={() => void cancel(r)}>Cancel</Button>} />
      ))}
    </Stack>
  )
}

function SickNotice({ onDone }: { onDone: () => void }) {
  const [busy, setBusy] = useState(false)
  return (
    <Alert
      severity="info"
      action={
        <Button
          color="inherit"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.ackLeaveNotice()
              onDone()
            } finally {
              setBusy(false)
            }
          }}
        >
          I've read this
        </Button>
      }
    >
      <Typography variant="subtitle2">Your paid sick leave in Washington</Typography>
      You earn at least 1 hour of paid sick leave for every 40 hours you work, overtime and travel included. You can use it from your 90th day for your own or a family member's illness, injury,
      medical care or preventive care, when your workplace or a child's school is closed for health reasons, and for domestic violence leave. You don't have to say why, and no reason is kept. Up to
      40 unused hours carry into the next year. Retaliation for using it is against the law.
    </Alert>
  )
}

function BalanceCard({ type, b }: { type?: LeaveType; b: LeaveBalance }) {
  return (
    <Paper sx={{ p: 1.5, minWidth: 150, flex: '1 1 150px' }}>
      <Typography variant="body2" color="text.secondary">
        {type?.name ?? 'Leave'}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {h(b.available)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {[b.pending ? `${h(b.pending)} waiting` : '', b.booked ? `${h(b.booked)} booked` : '', type?.usableFrom ? `usable from ${fmtDay(type.usableFrom)}` : ''].filter(Boolean).join(' · ') || 'available'}
      </Typography>
    </Paper>
  )
}

function RequestRow({ r, action, showPerson }: { r: LeaveRequest; action?: React.ReactNode; showPerson?: boolean }) {
  return (
    <Paper sx={{ p: 1.5 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600 }} noWrap>
            {showPerson ? `${r.person.name} · ` : ''}
            {r.leaveType.name}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {span(r)} · {h(r.hours)}
            {r.note ? ` · ${r.note}` : ''}
          </Typography>
          {r.decisionNote && (
            <Typography variant="caption" color="text.secondary">
              {r.decidedBy}: {r.decisionNote}
            </Typography>
          )}
        </Box>
        <Chip size="small" color={STATUS_COLOR[r.status]} label={STATUS_TEXT[r.status]} />
        {action}
      </Stack>
    </Paper>
  )
}

function RequestForm({ types, personId, onDone, people, approveNow }: { types: LeaveType[]; personId: string; onDone: () => void; people?: { id: string; name: string }[]; approveNow?: boolean }) {
  const [who, setWho] = useState(personId)
  const [typeId, setTypeId] = useState(types[0]?.id ?? '')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [hours, setHours] = useState('8')
  const [weekends, setWeekends] = useState(false)
  const [note, setNote] = useState('')
  const [approve, setApprove] = useState(Boolean(approveNow))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const type = types.find((t) => t.id === typeId)
  const sick = type?.statutory === 'wa_sick'
  const submit = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.askLeave({
        personId: who,
        leaveTypeId: typeId,
        startDate: start,
        endDate: end || start,
        hoursPerDay: Number(hours),
        includeWeekends: weekends,
        note: sick ? undefined : note,
        approve: people ? approve : undefined,
      })
      setMsg({ ok: true, text: r.status === 'approved' ? `Recorded and approved: ${h(r.hours)}.` : `Asked for ${h(r.hours)}. Your supervisor will see it.` })
      setStart('')
      setEnd('')
      setNote('')
      onDone()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }
  if (!types.length) return null
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          {people ? 'Record time off for someone' : 'Ask for time off'}
        </Typography>
        {people && (
          <TextField select label="Person" value={who} onChange={(e) => setWho(e.target.value)} size="small">
            {people.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.name}
              </MenuItem>
            ))}
          </TextField>
        )}
        <TextField select label="Kind" value={typeId} onChange={(e) => setTypeId(e.target.value)} size="small">
          {types.map((t) => (
            <MenuItem key={t.id} value={t.id}>
              {t.name}
            </MenuItem>
          ))}
        </TextField>
        <Stack direction="row" spacing={1}>
          <TextField type="date" label="First day" value={start} onChange={(e) => setStart(e.target.value)} size="small" InputLabelProps={{ shrink: true }} sx={{ flex: 1 }} />
          <TextField type="date" label="Last day" value={end} onChange={(e) => setEnd(e.target.value)} size="small" InputLabelProps={{ shrink: true }} sx={{ flex: 1 }} helperText="Blank = one day" />
        </Stack>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField label="Hours each day" value={hours} onChange={(e) => setHours(e.target.value)} size="small" inputProps={{ inputMode: 'decimal' }} sx={{ width: 140 }} />
          <FormControlLabel control={<Checkbox checked={weekends} onChange={(e) => setWeekends(e.target.checked)} />} label="Count weekends" />
        </Stack>
        {sick ? (
          <Typography variant="caption" color="text.secondary">
            No reason is needed for sick leave.
          </Typography>
        ) : (
          <TextField label="Note (optional)" value={note} onChange={(e) => setNote(e.target.value)} size="small" />
        )}
        {people && <FormControlLabel control={<Checkbox checked={approve} onChange={(e) => setApprove(e.target.checked)} />} label="Approve it now" />}
        {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
        <Box>
          <Button variant="contained" disabled={busy || !start || !typeId || !(Number(hours) > 0)} onClick={() => void submit()}>
            {people ? 'Record' : 'Ask'}
          </Button>
        </Box>
      </Stack>
    </Paper>
  )
}

// ─── Approve ────────────────────────────────────────────────────────────────

function Approve({ meId }: { meId: string }) {
  const [rows, setRows] = useState<LeaveRequest[] | null>(null)
  const [error, setError] = useState('')
  const [denying, setDenying] = useState<LeaveRequest | null>(null)
  const [why, setWhy] = useState('')
  const load = useCallback(() => api.leaveRequests({ status: 'pending' }).then(setRows, (e) => setError(errorText(e))), [])
  useEffect(() => void load(), [load])
  const decide = async (r: LeaveRequest, d: 'approve' | 'deny', note = '') => {
    setError('')
    try {
      await api.decideLeave(r.id, d, note)
      setDenying(null)
      setWhy('')
      await load()
    } catch (e) {
      setError(errorText(e))
    }
  }
  if (!rows) return error ? <Alert severity="error">{error}</Alert> : <CircularProgress />
  return (
    <Stack spacing={1.5}>
      {error && <Alert severity="error">{error}</Alert>}
      {rows.length === 0 && <Typography color="text.secondary">Nothing waiting.</Typography>}
      {rows.map((r) => (
        <RequestRow
          key={r.id}
          r={r}
          showPerson
          action={
            r.person.id === meId ? (
              <Typography variant="caption" color="text.secondary">
                Yours: someone else decides
              </Typography>
            ) : (
              <Stack direction="row" spacing={0.5}>
                <Button size="small" onClick={() => setDenying(r)}>
                  Deny
                </Button>
                <Button size="small" variant="contained" onClick={() => void decide(r, 'approve')}>
                  Approve
                </Button>
              </Stack>
            )
          }
        />
      ))}
      <Dialog open={Boolean(denying)} onClose={() => setDenying(null)} fullWidth maxWidth="xs">
        <DialogTitle>Not approve this time off</DialogTitle>
        <DialogContent>
          <TextField autoFocus fullWidth label="Why (they will see this)" value={why} onChange={(e) => setWhy(e.target.value)} sx={{ mt: 1 }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDenying(null)}>Back</Button>
          <Button variant="contained" color="error" disabled={!why.trim()} onClick={() => denying && void decide(denying, 'deny', why.trim())}>
            Deny
          </Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

// ─── Team ───────────────────────────────────────────────────────────────────

function Team({ meId, canWrite, canRecord }: { meId: string; canWrite: boolean; canRecord: boolean }) {
  const [team, setTeam] = useState<LeaveTeam | null>(null)
  const [policies, setPolicies] = useState<LeavePolicy[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<LeaveTeam['people'][number] | null>(null)
  const load = useCallback(async () => {
    try {
      setTeam(await api.leaveTeam())
      if (canWrite) setPolicies(await api.leavePolicies())
    } catch (e) {
      setError(errorText(e))
    }
  }, [canWrite])
  useEffect(() => void load(), [load])
  if (!team) return error ? <Alert severity="error">{error}</Alert> : <CircularProgress />
  const balanceTypes = team.types.filter((t) => t.drawsBalance)
  return (
    <Stack spacing={2}>
      <TableContainer component={Paper}>
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Person</TableCell>
              {balanceTypes.map((t) => (
                <TableCell key={t.id} align="right">
                  {t.name}
                </TableCell>
              ))}
              <TableCell>Hired</TableCell>
              {canWrite && <TableCell />}
            </TableRow>
          </TableHead>
          <TableBody>
            {team.people.map((p) => (
              <TableRow key={p.id}>
                <TableCell>{p.name}</TableCell>
                {balanceTypes.map((t) => {
                  const b = p.balances.find((x) => x.leaveTypeId === t.id)
                  return (
                    <TableCell key={t.id} align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      {b ? h(b.available) : '0 h'}
                      {b?.pending ? ` (${h(b.pending)} waiting)` : ''}
                    </TableCell>
                  )
                })}
                <TableCell>{p.hireDate ?? '—'}</TableCell>
                {canWrite && (
                  <TableCell align="right">
                    <Button size="small" onClick={() => setEditing(p)}>
                      Change
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {canRecord && (
        <RequestForm
          types={team.types}
          personId={team.people.find((p) => p.id !== meId)?.id ?? ''}
          people={team.people.filter((p) => p.id !== meId)}
          approveNow
          onDone={() => void load()}
        />
      )}
      {editing && <PersonDialog person={editing} types={balanceTypes} policies={policies} isMe={editing.id === meId} onClose={() => setEditing(null)} onSaved={() => void load()} />}
    </Stack>
  )
}

function PersonDialog({
  person,
  types,
  policies,
  isMe,
  onClose,
  onSaved,
}: {
  person: LeaveTeam['people'][number]
  types: LeaveType[]
  policies: LeavePolicy[]
  isMe: boolean
  onClose: () => void
  onSaved: () => void
}) {
  const [hire, setHire] = useState(person.hireDate ?? '')
  const [adjType, setAdjType] = useState(types[0]?.id ?? '')
  const [adjHours, setAdjHours] = useState('')
  const [adjNote, setAdjNote] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setMsg(null)
    try {
      await fn()
      setMsg({ ok: true, text: done })
      onSaved()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    }
  }
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>{person.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <TextField type="date" label="Hire date" value={hire} onChange={(e) => setHire(e.target.value)} size="small" InputLabelProps={{ shrink: true }} helperText="The 90-day sick-leave wait counts from it" />
            <Button onClick={() => void act(() => api.setHireDate(person.id, hire || null), 'Hire date saved.')}>Save</Button>
          </Stack>
          {types.map((t) => {
            const options = policies.filter((p) => p.leaveTypeId === t.id && p.active)
            return (
              <TextField
                key={t.id}
                select
                size="small"
                label={`${t.name} policy`}
                value={person.policies[t.id] ?? ''}
                onChange={(e) => void act(() => api.assignLeavePolicy(person.id, t.id, e.target.value || null), `${t.name} policy changed from today.`)}
                helperText={t.statutory === 'wa_sick' ? 'Blank = the company sick-leave policy' : 'Blank = earns none'}
              >
                <MenuItem value="">
                  <em>None set</em>
                </MenuItem>
                {options.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                ))}
              </TextField>
            )
          })}
          {isMe ? (
            <Typography variant="body2" color="text.secondary">
              Someone else has to change your own balances.
            </Typography>
          ) : (
            <Paper variant="outlined" sx={{ p: 1.5 }}>
              <Stack spacing={1}>
                <Typography variant="subtitle2">Correct a balance</Typography>
                <Stack direction="row" spacing={1}>
                  <TextField select size="small" label="Kind" value={adjType} onChange={(e) => setAdjType(e.target.value)} sx={{ flex: 1 }}>
                    {types.map((t) => (
                      <MenuItem key={t.id} value={t.id}>
                        {t.name}
                      </MenuItem>
                    ))}
                  </TextField>
                  <TextField size="small" label="Hours (+ or −)" value={adjHours} onChange={(e) => setAdjHours(e.target.value)} inputProps={{ inputMode: 'decimal' }} sx={{ width: 140 }} />
                </Stack>
                <TextField size="small" label="Why (required)" value={adjNote} onChange={(e) => setAdjNote(e.target.value)} />
                <Box>
                  <Button
                    disabled={!adjNote.trim() || !Number(adjHours)}
                    onClick={() =>
                      void act(async () => {
                        await api.adjustLeave({ personId: person.id, leaveTypeId: adjType, hours: Number(adjHours), note: adjNote.trim() })
                        setAdjHours('')
                        setAdjNote('')
                      }, 'Balance corrected.')
                    }
                  >
                    Correct
                  </Button>
                </Box>
              </Stack>
            </Paper>
          )}
          {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Set up ─────────────────────────────────────────────────────────────────

function Setup() {
  const [settings, setSettings] = useState<LeaveSettings | null>(null)
  const [policies, setPolicies] = useState<LeavePolicy[]>([])
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    try {
      setSettings(await api.leaveSettings())
      setPolicies(await api.leavePolicies())
    } catch (e) {
      setError(errorText(e))
    }
  }, [])
  useEffect(() => void load(), [load])
  if (!settings) return error ? <Alert severity="error">{error}</Alert> : <CircularProgress />
  const save = async (s: Partial<LeaveSettings>) => {
    setError('')
    try {
      setSettings(await api.saveLeaveSettings(s))
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <Stack spacing={2}>
      {error && <Alert severity="error">{error}</Alert>}
      <Paper sx={{ p: 2 }}>
        <Stack spacing={1}>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            Company
          </Typography>
          <TextField select size="small" label="Banks" value={settings.banks} onChange={(e) => void save({ banks: e.target.value as LeaveSettings['banks'] })} sx={{ maxWidth: 320 }}>
            <MenuItem value="separate">Separate sick and vacation</MenuItem>
            <MenuItem value="combined">One PTO bank</MenuItem>
          </TextField>
          <FormControlLabel
            control={<Switch checked={settings.sickPayoutAtSeparation} onChange={(e) => void save({ sickPayoutAtSeparation: e.target.checked })} />}
            label="Pay out sick balance when someone leaves"
          />
          <Typography variant="body2" color="text.secondary">
            Switchover day: {settings.switchoverDate ?? 'not set (set by the opening-balance import)'}
          </Typography>
        </Stack>
      </Paper>
      <Policies policies={policies} onSaved={() => void load()} />
      <Accrual />
      <Import onPosted={() => void load()} />
    </Stack>
  )
}

const METHOD_TEXT: Record<string, string> = { per_hours_worked: 'Per hours worked', per_period: 'Per pay period', annual_grant: 'Once a year', none: 'Not earned' }

function Policies({ policies, onSaved }: { policies: LeavePolicy[]; onSaved: () => void }) {
  const [edit, setEdit] = useState<LeavePolicy | null>(null)
  const [msg, setMsg] = useState('')
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v))
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          Policies
        </Typography>
        {policies.map((p) => (
          <Stack key={p.id} direction="row" spacing={1} alignItems="center">
            <Box sx={{ flex: 1 }}>
              <Typography sx={{ fontWeight: 600 }}>{p.name}</Typography>
              <Typography variant="body2" color="text.secondary">
                {METHOD_TEXT[p.method]}
                {p.method === 'per_hours_worked' ? `: ${p.rateHours} h per ${p.perHours} h worked` : ''}
                {p.method === 'per_period' || p.method === 'annual_grant' ? `: ${p.periodHours} h` : ''}
                {` · cap ${p.balanceCap ?? 'none'} · carries over ${p.carryoverMax ?? 'all'} · wait ${p.waitingDays} days`}
              </Typography>
            </Box>
            <Button size="small" onClick={() => setEdit({ ...p })}>
              Change
            </Button>
          </Stack>
        ))}
      </Stack>
      {edit && (
        <Dialog open onClose={() => setEdit(null)} fullWidth maxWidth="xs">
          <DialogTitle>{edit.name}</DialogTitle>
          <DialogContent>
            <Stack spacing={1.5} sx={{ pt: 1 }}>
              <TextField size="small" label="Name" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
              <TextField select size="small" label="Earned" value={edit.method} onChange={(e) => setEdit({ ...edit, method: e.target.value as LeavePolicy['method'] })}>
                {Object.entries(METHOD_TEXT).map(([k, v]) => (
                  <MenuItem key={k} value={k}>
                    {v}
                  </MenuItem>
                ))}
              </TextField>
              {edit.method === 'per_hours_worked' && (
                <Stack direction="row" spacing={1}>
                  <TextField size="small" label="Hours earned" value={edit.rateHours} onChange={(e) => setEdit({ ...edit, rateHours: Number(e.target.value) })} />
                  <TextField size="small" label="per hours worked" value={edit.perHours} onChange={(e) => setEdit({ ...edit, perHours: Number(e.target.value) })} />
                </Stack>
              )}
              {(edit.method === 'per_period' || edit.method === 'annual_grant') && (
                <TextField size="small" label={edit.method === 'per_period' ? 'Hours each pay period' : 'Hours each year'} value={edit.periodHours} onChange={(e) => setEdit({ ...edit, periodHours: Number(e.target.value) })} />
              )}
              <TextField size="small" label="Balance cap (blank = none)" value={edit.balanceCap ?? ''} onChange={(e) => setEdit({ ...edit, balanceCap: numOrNull(e.target.value) })} />
              <TextField size="small" label="Carry over at most (blank = all)" value={edit.carryoverMax ?? ''} onChange={(e) => setEdit({ ...edit, carryoverMax: numOrNull(e.target.value) })} />
              <TextField size="small" label="Usable after (days from hire)" value={edit.waitingDays} onChange={(e) => setEdit({ ...edit, waitingDays: Number(e.target.value) })} />
              {msg && <Alert severity="error">{msg}</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions>
            <Button onClick={() => setEdit(null)}>Cancel</Button>
            <Button
              variant="contained"
              onClick={async () => {
                setMsg('')
                try {
                  const { id, leaveTypeId: _t, ...rest } = edit
                  await api.updateLeavePolicy(id, rest)
                  setEdit(null)
                  onSaved()
                } catch (e) {
                  setMsg(errorText(e))
                }
              }}
            >
              Save
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Paper>
  )
}

function Accrual() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [preview, setPreview] = useState<AccrualRun | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    api.payPeriods().then(
      (p) => {
        setFrom(p.previous.from)
        setTo(p.previous.to)
      },
      () => undefined,
    )
  }, [])
  const run = async (dry: boolean) => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.runAccrual(from, to, dry)
      setPreview(dry ? r : null)
      if (!dry) setMsg({ ok: true, text: r.posted ? `Posted ${r.posted} accrual entries.` : 'Nothing new to post: this period is already up to date.' })
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }
  const earning = preview?.people.filter((p) => p.accruals.some((a) => a.earned || a.posted)) ?? []
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          Earn leave for a pay period
        </Typography>
        <Typography variant="body2" color="text.secondary">
          From approved hours only. Running a period again adds only what changed.
        </Typography>
        <Stack direction="row" spacing={1}>
          <TextField type="date" size="small" label="From" value={from} onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField type="date" size="small" label="To" value={to} onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button disabled={busy || !from || !to} onClick={() => void run(true)}>
            Preview
          </Button>
          <Button variant="contained" disabled={busy || !preview} onClick={() => void run(false)}>
            Post
          </Button>
        </Stack>
        {preview && (
          <>
            {preview.notReady.length > 0 && (
              <Alert severity="warning">
                {preview.notReady.length} week(s) are not approved yet; their hours are left out until they are. {preview.notReady.map((n) => n.personName).join(', ')}
              </Alert>
            )}
            {earning.length === 0 && <Typography color="text.secondary">No one earns leave in this period.</Typography>}
            {earning.map((p) => (
              <Typography key={p.personId} variant="body2">
                {p.personName}: {h(p.hoursWorked)} worked → {p.accruals.map((a) => `+${h(a.earned)}${a.note ? ` (${a.note})` : ''}`).join(', ')}
              </Typography>
            ))}
            {preview.people.filter((p) => p.skipped).map((p) => (
              <Typography key={p.personId} variant="caption" color="text.secondary">
                {p.personName}: {p.skipped}
              </Typography>
            ))}
          </>
        )}
        {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      </Stack>
    </Paper>
  )
}

function Import({ onPosted }: { onPosted: () => void }) {
  const [file, setFile] = useState<{ name: string; b64: string } | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [mapping, setMapping] = useState<ImportMapping | null>(null)
  const [chosen, setChosen] = useState<Record<string, string>>({})
  const [skip, setSkip] = useState<number[]>([])
  const [switchover, setSwitchover] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)

  const body = useCallback(
    (m: ImportMapping | null, c: Record<string, string>, s: number[]): ImportBody | null =>
      file ? { fileName: file.name, contentBase64: file.b64, mapping: m ?? undefined, chosen: c, skip: s, switchoverDate: switchover || undefined } : null,
    [file, switchover],
  )
  const refresh = useCallback(
    async (m: ImportMapping | null, c: Record<string, string>, s: number[]) => {
      const b = body(m, c, s)
      if (!b) return
      setBusy(true)
      setMsg(null)
      try {
        const p = await api.previewImport(b)
        setPreview(p)
        setMapping(p.mapping)
        if (!switchover && p.switchoverDate) setSwitchover(p.switchoverDate)
      } catch (e) {
        setMsg({ ok: false, text: errorText(e) })
      } finally {
        setBusy(false)
      }
    },
    [body, switchover],
  )
  useEffect(() => {
    if (file) void refresh(null, {}, [])
    // Only when a new file is picked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file])

  const pick = (f: File | undefined) => {
    if (!f) return
    const reader = new FileReader()
    reader.onload = () => {
      setChosen({})
      setSkip([])
      setPreview(null)
      setFile({ name: f.name, b64: String(reader.result).replace(/^data:[^,]*,/, '') })
    }
    reader.readAsDataURL(f)
  }
  const cols = useMemo(() => (preview?.headers ?? []).map((hd, i) => ({ i, label: hd || `Column ${i + 1}` })), [preview])
  const colSelect = (label: string, value: number | null, set: (v: number | null) => void) => (
    <TextField select size="small" label={label} value={value ?? ''} onChange={(e) => set(e.target.value === '' ? null : Number(e.target.value))} sx={{ minWidth: 160 }}>
      <MenuItem value="">
        <em>None</em>
      </MenuItem>
      {cols.map((c) => (
        <MenuItem key={c.i} value={c.i}>
          {c.label}
        </MenuItem>
      ))}
    </TextField>
  )
  const changeMapping = (m: ImportMapping) => {
    setMapping(m)
    void refresh(m, chosen, skip)
  }
  const post = async () => {
    const b = body(mapping, chosen, skip)
    if (!b) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.commitImport(b)
      setMsg({ ok: true, text: `Posted ${r.posted} opening balances as of ${r.switchoverDate}.` })
      setPreview(null)
      setFile(null)
      onPosted()
    } catch (e) {
      setMsg({ ok: false, text: errorText(e) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1.5}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
          Opening balances from the finance spreadsheet
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Pick the .xlsx or .csv. Nothing is saved until you press Post. Each person gets one entry per kind of leave, dated the switchover day, and hours worked before that day earn
          nothing here (the sheet already counts them).
        </Typography>
        <Box>
          <Button component="label" variant="outlined" disabled={busy}>
            {file ? file.name : 'Choose file'}
            <input hidden type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => pick(e.target.files?.[0])} />
          </Button>
        </Box>
        {busy && <CircularProgress size={24} />}
        {preview && mapping && (
          <>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              <TextField
                select
                size="small"
                label="Headings row"
                value={mapping.headerRow}
                onChange={(e) => changeMapping({ ...mapping, headerRow: Number(e.target.value) })}
                sx={{ minWidth: 140 }}
              >
                {preview.sample.map((r, i) => (
                  <MenuItem key={i} value={i}>
                    Row {i + 1}: {r.filter(Boolean).slice(0, 3).join(', ').slice(0, 40)}
                  </MenuItem>
                ))}
              </TextField>
              {colSelect('Name column', mapping.nameCol, (v) => changeMapping({ ...mapping, nameCol: v }))}
              {colSelect('Email column', mapping.emailCol, (v) => changeMapping({ ...mapping, emailCol: v }))}
              {preview.leaveTypes.map((t) =>
                colSelect(`${t.name} balance`, mapping.columns.find((c) => c.leaveTypeId === t.id)?.col ?? null, (v) =>
                  changeMapping({ ...mapping, columns: [...mapping.columns.filter((c) => c.leaveTypeId !== t.id), ...(v === null ? [] : [{ col: v, leaveTypeId: t.id }])] }),
                ),
              )}
            </Stack>
            {preview.mappingProblem && <Alert severity="warning">{preview.mappingProblem}</Alert>}
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Row</TableCell>
                    <TableCell>In the sheet</TableCell>
                    <TableCell>Logbook person</TableCell>
                    {preview.leaveTypes
                      .filter((t) => mapping.columns.some((c) => c.leaveTypeId === t.id))
                      .map((t) => (
                        <TableCell key={t.id} align="right">
                          {t.name}
                        </TableCell>
                      ))}
                    <TableCell>Leave out</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {preview.rows.map((r) => (
                    <TableRow key={r.sheetRow} sx={{ bgcolor: r.problems.length ? 'warning.light' : undefined }}>
                      <TableCell>{r.sheetRow}</TableCell>
                      <TableCell>
                        {r.name || r.email}
                        {r.problems.map((p) => (
                          <Typography key={p} variant="caption" display="block" color="text.secondary">
                            {p}
                          </Typography>
                        ))}
                      </TableCell>
                      <TableCell>
                        <TextField
                          select
                          size="small"
                          value={r.personId ?? ''}
                          onChange={(e) => {
                            const c = { ...chosen, [String(r.sheetRow)]: e.target.value }
                            setChosen(c)
                            void refresh(mapping, c, skip)
                          }}
                          sx={{ minWidth: 160 }}
                        >
                          <MenuItem value="">
                            <em>Pick</em>
                          </MenuItem>
                          {preview.people.map((p) => (
                            <MenuItem key={p.id} value={p.id}>
                              {p.name} ({p.email})
                            </MenuItem>
                          ))}
                        </TextField>
                      </TableCell>
                      {r.balances.map((b) => (
                        <TableCell key={b.leaveTypeId} align="right">
                          {b.hours === null ? b.raw || '—' : h(b.hours)}
                        </TableCell>
                      ))}
                      <TableCell>
                        <Checkbox
                          checked={false}
                          onChange={() => {
                            const s = [...skip, r.sheetRow]
                            setSkip(s)
                            void refresh(mapping, chosen, s)
                          }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {skip.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                Left out: rows {skip.join(', ')}.{' '}
                <Button
                  size="small"
                  onClick={() => {
                    setSkip([])
                    void refresh(mapping, chosen, [])
                  }}
                >
                  Put back
                </Button>
              </Typography>
            )}
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                type="date"
                size="small"
                label="Switchover day"
                value={switchover}
                onChange={(e) => setSwitchover(e.target.value)}
                InputLabelProps={{ shrink: true }}
                helperText="The day the sheet's balances are as of"
              />
              <Button variant="contained" disabled={busy || !preview.ready || !switchover} onClick={() => void post()}>
                Post
              </Button>
            </Stack>
            {!preview.ready && !preview.mappingProblem && <Typography variant="caption">Every row needs a person and no problems before it can be posted. Fix or leave out the rows marked.</Typography>}
          </>
        )}
        {msg && <Alert severity={msg.ok ? 'success' : 'error'}>{msg.text}</Alert>}
      </Stack>
    </Paper>
  )
}
