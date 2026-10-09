import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  Tab,
  Tabs,
  TextField,
  Typography,
  useMediaQuery,
} from '@mui/material'
import {
  addDays,
  api,
  errorText,
  fmtDay,
  fmtWeek,
  fromLocalInput,
  toLocalInput,
  type Job,
  type Person,
  type PersonWeek,
  type Phase,
  type Reconcile,
  type ReviewPunch,
  type WeekRow,
  type WeekSummary,
} from '../api'
import WeekView, { StatusChips, WeekPicker } from '../components/WeekView'

// The manager's week: who has signed, what needs a look, approve. Any manager can
// approve anyone. Approved weeks are frozen until reopened with a reason.

/** Signed, nothing flagged, not on the clock: safe to approve in one go. */
const ready = (r: WeekRow) => !r.approvedAt && Boolean(r.signedAt) && r.warnings === 0 && !r.onClock && r.hours > 0

export default function ReviewPage({ me }: { me: Person }) {
  const canApprove = me.scopes.includes('time:approve')
  const canEdit = me.scopes.includes('punch:write:any')
  const [view, setView] = useState<'people' | 'reconcile'>('people')
  const [week, setWeek] = useState<string | undefined>(undefined)
  const [maxWeek, setMaxWeek] = useState<string | undefined>(undefined)
  const [data, setData] = useState<WeekSummary | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [openPerson, setOpenPerson] = useState<string | null>(null)

  const load = useCallback(async (w?: string) => {
    try {
      const d = await api.weekSummary(w)
      setData(d)
      setWeek(d.week)
      // The default is last week, so the current week is one after the first answer.
      setMaxWeek((m) => m ?? addDays(d.week, 7))
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const changeWeek = (w: string) => {
    setSelected([])
    setNotice('')
    void load(w)
  }

  const approve = async (ids: string[]) => {
    if (!data || !ids.length) return
    setBusy(true)
    setNotice('')
    try {
      const r = await api.approve(data.week, ids)
      const failed = r.results.filter((x) => !x.ok)
      const names = new Map(data.rows.map((x) => [x.personId, x.name]))
      setNotice(
        [r.approved ? `Approved ${r.approved} ${r.approved === 1 ? 'week' : 'weeks'}.` : '', ...failed.map((f) => `${names.get(f.personId) ?? 'Someone'}: ${f.message}`)]
          .filter(Boolean)
          .join(' '),
      )
      setSelected([])
      await load(data.week)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!data || !week) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
      </Stack>
    )
  }

  const readyIds = data.rows.filter(ready).map((r) => r.personId)
  const selectable = (r: WeekRow) => canApprove && data.ended && !r.approvedAt && !r.onClock && r.hours > 0

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" useFlexGap spacing={1}>
        <WeekPicker week={week} maxWeek={maxWeek} onChange={changeWeek} />
        <Tabs value={view} onChange={(_, v) => setView(v)}>
          <Tab value="people" label="People" />
          <Tab value="reconcile" label="vs Timesheets" />
        </Tabs>
      </Stack>

      {view === 'reconcile' && <ReconcileView week={week} />}

      {view === 'people' && (
        <>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center">
            <Chip label={`${data.totals.hours.toFixed(1)} h`} sx={{ fontWeight: 700 }} />
            <Chip variant="outlined" label={`${data.totals.signed}/${data.totals.people} signed`} />
            <Chip variant="outlined" color={data.totals.approved === data.totals.people ? 'success' : 'default'} label={`${data.totals.approved}/${data.totals.people} approved`} />
            <Box sx={{ flex: 1 }} />
            {canApprove && data.ended && (
              <>
                {selected.length > 0 && (
                  <Button variant="outlined" disabled={busy} onClick={() => void approve(selected)}>
                    Approve {selected.length} selected
                  </Button>
                )}
                <Button variant="contained" disabled={busy || readyIds.length === 0} onClick={() => void approve(readyIds)}>
                  Approve {readyIds.length} ready
                </Button>
              </>
            )}
          </Stack>
          {!data.ended && <Alert severity="info">This week is not over yet. It can be approved from {fmtDay(addDays(data.week, 7))}.</Alert>}
          {canApprove && data.ended && (
            <Typography variant="body2" color="text.secondary">
              Ready means signed by the tech, nothing flagged, and off the clock. Open anyone to look closer, correct a segment, or approve them on their own.
            </Typography>
          )}
          {notice && <Alert severity={notice.includes(':') ? 'warning' : 'success'} onClose={() => setNotice('')}>{notice}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}

          {data.rows.map((r) => (
            <Paper key={r.personId} sx={{ p: 1.25, opacity: r.active ? 1 : 0.6, cursor: 'pointer', '&:hover': { borderColor: 'primary.light' } }} onClick={() => setOpenPerson(r.personId)}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Checkbox
                  size="small"
                  disabled={!selectable(r)}
                  checked={selected.includes(r.personId)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={(e) => setSelected(e.target.checked ? [...selected, r.personId] : selected.filter((x) => x !== r.personId))}
                  inputProps={{ 'aria-label': `Select ${r.name}` }}
                  sx={{ visibility: canApprove ? 'visible' : 'hidden' }}
                />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }} noWrap>
                    {r.name}
                  </Typography>
                  <Stack direction="row" spacing={0.75} sx={{ mt: 0.25 }} flexWrap="wrap" useFlexGap>
                    <StatusChips signedAt={r.signedAt} approvedAt={r.approvedAt} approvedBy={r.approvedBy} onClock={r.onClock} />
                    {r.warnings > 0 && <Chip size="small" color="warning" label={`${r.warnings} to look at`} />}
                  </Stack>
                </Box>
                <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{r.hours.toFixed(2)} h</Typography>
              </Stack>
            </Paper>
          ))}
        </>
      )}

      {openPerson && (
        <PersonDialog
          personId={openPerson}
          week={week}
          canApprove={canApprove}
          canEdit={canEdit}
          onClose={(changed) => {
            setOpenPerson(null)
            if (changed) void load(week)
          }}
        />
      )}
    </Stack>
  )
}

// ─── One person's week ──────────────────────────────────────────────────────

function PersonDialog({ personId, week, canApprove, canEdit, onClose }: { personId: string; week: string; canApprove: boolean; canEdit: boolean; onClose: (changed: boolean) => void }) {
  const full = useMediaQuery('(max-width:700px)')
  const [data, setData] = useState<PersonWeek | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [changed, setChanged] = useState(false)
  const [editing, setEditing] = useState<{ punch?: ReviewPunch; date?: string } | null>(null)
  const [reopening, setReopening] = useState(false)
  const [reason, setReason] = useState('')

  const load = useCallback(async () => {
    try {
      setData(await api.personWeek(personId, week))
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [personId, week])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      setChanged(true)
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const approve = () =>
    act(async () => {
      const r = await api.approve(week, [personId])
      if (r.failed) throw new Error(r.results[0]?.message ?? 'Could not approve.')
    })

  return (
    <Dialog open fullScreen={full} fullWidth maxWidth="md" onClose={() => onClose(changed)}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
          <Box sx={{ flex: 1, minWidth: 160 }}>
            {data?.person.name ?? '…'}
            <Typography variant="body2" color="text.secondary">
              Week of {fmtWeek(week)} · {data ? `${data.hours.toFixed(2)} h` : ''}
            </Typography>
          </Box>
          {data && <StatusChips signedAt={data.signedAt} approvedAt={data.approvedAt} approvedBy={data.approvedBy} onClock={data.onClock} />}
        </Stack>
      </DialogTitle>
      <DialogContent dividers sx={{ bgcolor: 'background.default' }}>
        {error && (
          <Alert severity="error" sx={{ mb: 1.5 }}>
            {error}
          </Alert>
        )}
        {data && !data.signedAt && !data.approvedAt && data.hours > 0 && (
          <Alert severity="info" sx={{ mb: 1.5 }}>
            Not signed by {data.person.name.split(' ')[0]} yet. You can still approve it.
          </Alert>
        )}
        {data ? (
          <WeekView data={data} onEdit={canEdit ? (p) => setEditing({ punch: p }) : undefined} onAdd={canEdit ? (date) => setEditing({ date }) : undefined} />
        ) : (
          <Stack alignItems="center" sx={{ py: 4 }}>
            <CircularProgress />
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(changed)}>Close</Button>
        {canApprove && data?.approvedAt && (
          <Button color="warning" disabled={busy} onClick={() => setReopening(true)}>
            Reopen
          </Button>
        )}
        {canApprove && data && !data.approvedAt && (
          <Button variant="contained" disabled={busy || !data.ended || data.onClock} onClick={() => void approve()}>
            {data.ended ? 'Approve week' : 'Week not over'}
          </Button>
        )}
      </DialogActions>

      {editing && data && (
        <SegmentDialog
          personId={personId}
          punch={editing.punch}
          date={editing.date}
          onClose={(saved) => {
            setEditing(null)
            if (saved) {
              setChanged(true)
              void load()
            }
          }}
        />
      )}

      <Dialog open={reopening} onClose={() => setReopening(false)} fullWidth maxWidth="xs">
        <DialogTitle>Reopen this week</DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <Typography variant="body2" color="text.secondary">
              Its time can be corrected again, and it will need approving again. The tech will be asked to sign again.
            </Typography>
            <TextField label="Why" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReopening(false)}>Cancel</Button>
          <Button
            color="warning"
            variant="contained"
            disabled={busy || !reason.trim()}
            onClick={() => {
              setReopening(false)
              void act(() => api.reopen(week, personId, reason.trim()))
              setReason('')
            }}
          >
            Reopen
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  )
}

// ─── Correct a segment, or add one that was never punched ───────────────────

let jobsCache: Job[] | null = null
let phasesCache: Phase[] | null = null

function SegmentDialog({ personId, punch, date, onClose }: { personId: string; punch?: ReviewPunch; date?: string; onClose: (saved: boolean) => void }) {
  const [jobs, setJobs] = useState<Job[]>(jobsCache ?? [])
  const [phases, setPhases] = useState<Phase[]>(phasesCache ?? [])
  const [jobId, setJobId] = useState(punch?.jobId ?? '')
  const [phaseId, setPhaseId] = useState(punch?.phaseId ?? '')
  const [clockIn, setClockIn] = useState(punch ? toLocalInput(punch.clockIn) : date ? `${date}T07:00` : '')
  const [clockOut, setClockOut] = useState(punch ? toLocalInput(punch.clockOut) : date ? `${date}T15:30` : '')
  const [notes, setNotes] = useState(punch?.notes ?? '')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!jobsCache) void api.allJobs().then((j) => setJobs((jobsCache = j)))
    if (!phasesCache) void api.phases().then((p) => setPhases((phasesCache = p)))
  }, [])

  // Closed jobs stay pickable only when the segment is already on one.
  const options = useMemo(() => jobs.filter((j) => j.active || j.id === punch?.jobId), [jobs, punch?.jobId])
  const job = options.find((j) => j.id === jobId) ?? null

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      if (punch) {
        await api.editPunch(punch.id, {
          clockIn: fromLocalInput(clockIn),
          clockOut: clockOut ? fromLocalInput(clockOut) : null,
          jobId: jobId !== punch.jobId ? jobId : undefined,
          phaseId: phaseId !== (punch.phaseId ?? '') ? phaseId || null : undefined,
          notes: notes !== punch.notes ? notes : undefined,
          reason: reason.trim(),
        })
      } else {
        await api.addPunch({ personId, jobId, phaseId: phaseId || null, clockIn: fromLocalInput(clockIn), clockOut: fromLocalInput(clockOut), notes, reason: reason.trim() })
      }
      onClose(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={() => onClose(false)} fullWidth maxWidth="xs">
      <DialogTitle>{punch ? 'Correct segment' : 'Add time'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Start" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField
            label="End"
            type="datetime-local"
            value={clockOut}
            onChange={(e) => setClockOut(e.target.value)}
            InputLabelProps={{ shrink: true }}
            helperText={punch ? 'Clear it to leave the segment open (still on the clock)' : undefined}
          />
          <Autocomplete
            options={options}
            value={job}
            onChange={(_, j) => setJobId(j?.id ?? '')}
            getOptionLabel={(j) => (j.code && !j.name.includes(j.code) ? `${j.code} ${j.name}` : j.name)}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            renderInput={(params) => <TextField {...params} label="Job" />}
          />
          <TextField select label="Phase" value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
            <MenuItem value="">
              <em>None</em>
            </MenuItem>
            {phases.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Note" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <TextField label="Reason for the change" required value={reason} onChange={(e) => setReason(e.target.value)} helperText="Kept with the segment's history" />
          {punch && punch.edits.length > 0 && (
            <Box>
              <Typography variant="subtitle2">History</Typography>
              {punch.edits.map((e) => (
                <Typography key={e.id} variant="body2" color="text.secondary">
                  {new Date(e.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}: {e.reason}
                </Typography>
              ))}
            </Box>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(false)}>Cancel</Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy || !reason.trim() || !jobId || !clockIn || (!punch && !clockOut)}>
          Save
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Our hours against Timesheets.com ───────────────────────────────────────

function ReconcileView({ week }: { week: string }) {
  const [data, setData] = useState<Reconcile | null>(null)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    setData(null)
    api
      .reconcile(week, addDays(week, 6))
      .then((d) => {
        setData(d)
        setError('')
      })
      .catch((err) => setError(errorText(err)))
  }, [week])

  if (error) return <Alert severity="error">{error}</Alert>
  if (!data)
    return (
      <Stack alignItems="center" sx={{ py: 4 }}>
        <CircularProgress />
      </Stack>
    )

  return (
    <Stack spacing={1.25}>
      {!data.lastSyncedAt ? (
        <Alert severity="info">No Timesheets.com hours have arrived yet. GED sends them every 15 minutes once it is linked.</Alert>
      ) : (
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Chip label={`Ours ${data.totals.ours.toFixed(2)} h`} sx={{ fontWeight: 700 }} />
          <Chip variant="outlined" label={`Timesheets ${data.totals.theirs.toFixed(2)} h`} />
          <Chip color={data.totals.mismatchedDays ? 'warning' : 'success'} label={data.totals.mismatchedDays ? `${data.totals.mismatchedDays} days differ` : 'Every day matches'} />
        </Stack>
      )}
      <Typography variant="body2" color="text.secondary">
        Differences under {Math.round(data.toleranceHours * 60)} minutes count as a match. Cut over when this shows no unexplained differences for two pay periods.
      </Typography>
      {data.people.map((p) => (
        <Paper key={p.personId} sx={{ p: 1.25, cursor: 'pointer' }} onClick={() => setOpen(open === p.personId ? null : p.personId)}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Typography sx={{ fontWeight: 600, flex: 1 }} noWrap>
              {p.name}
            </Typography>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              {p.ours.toFixed(2)} / {p.theirs.toFixed(2)}
            </Typography>
            <Chip size="small" color={p.mismatchedDays ? 'warning' : 'success'} label={p.mismatchedDays ? `${p.diff > 0 ? '+' : ''}${p.diff.toFixed(2)} h` : 'match'} />
          </Stack>
          {open === p.personId && (
            <Box sx={{ mt: 1 }}>
              {data.rows
                .filter((r) => r.personId === p.personId)
                .map((r) => (
                  <Stack key={r.date} direction="row" spacing={1} sx={{ py: 0.25, borderTop: '1px solid', borderColor: 'divider', color: r.match ? 'text.secondary' : 'warning.main' }}>
                    <Typography variant="body2" sx={{ flex: 1 }}>
                      {fmtDay(r.date)}
                    </Typography>
                    <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                      ours {r.ours.toFixed(2)} · theirs {r.theirs === null ? '—' : r.theirs.toFixed(2)}
                    </Typography>
                  </Stack>
                ))}
            </Box>
          )}
        </Paper>
      ))}
      {data.lastSyncedAt && data.people.length === 0 && <Typography color="text.secondary">No hours in either system this week.</Typography>}
    </Stack>
  )
}
