import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Autocomplete, Box, Button, Chip, CircularProgress, Divider, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material'
import { api, errorText, fmtElapsed, fmtHours, fmtTime, type DayState, type Job, type Phase } from '../api'

// The tech's screen. Off the clock: pick the job, tap Clock In. On the clock: one big
// button moves to the next phase of the day; Switch job and Clock Out sit under it.

const KIND_LABEL: Record<Job['kind'], string> = { project: 'Projects', service: 'Service', shop: 'Shop', other: 'Other' }

const useNow = (everyMs: number) => {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

export default function PunchPage() {
  const [state, setState] = useState<DayState | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [job, setJob] = useState<Job | null>(null)
  const [phaseId, setPhaseId] = useState('')
  const [switching, setSwitching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(15_000)

  const load = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([api.state(), api.jobs()])
      setState(s)
      setJobs(j)
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void load()
    const onFocus = () => void load()
    window.addEventListener('focus', onFocus)
    const t = setInterval(() => void load(), 60_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(t)
    }
  }, [load])

  // Suggest the phase the day is up to; the tech can change it.
  useEffect(() => {
    if (state && !phaseId) setPhaseId(state.nextPhase?.id ?? state.phases[0]?.id ?? '')
  }, [state, phaseId])

  // Suggest the job last worked today.
  useEffect(() => {
    if (job || !state || !jobs.length) return
    const last = state.today.length ? state.today[state.today.length - 1] : null
    const match = last ? jobs.find((j) => j.id === last.jobId) : null
    if (match) setJob(match)
  }, [state, jobs, job])

  const act = async (fn: () => Promise<{ state: DayState }>) => {
    setBusy(true)
    setError('')
    try {
      const r = await fn()
      setState(r.state)
      setSwitching(false)
      setPhaseId(r.state.nextPhase?.id ?? '')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const sortedJobs = useMemo(
    () => [...jobs].sort((a, b) => KIND_LABEL[a.kind].localeCompare(KIND_LABEL[b.kind]) || a.name.localeCompare(b.name)),
    [jobs],
  )

  if (!state) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
        {error && <Button onClick={() => void load()}>Try again</Button>}
      </Stack>
    )
  }

  const open = state.open
  const picking = !state.onClock || switching
  const phaseIndex = open?.phase ? state.phases.findIndex((p) => p.id === open.phase!.id) : -1

  return (
    <Stack spacing={2}>
      <Paper sx={{ p: 2.5, borderColor: state.onClock ? 'success.main' : undefined, borderWidth: state.onClock ? 2 : 1 }}>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <Chip size="small" color={state.onClock ? 'success' : 'default'} label={state.onClock ? 'On the clock' : 'Off the clock'} sx={{ fontWeight: 700 }} />
            <Box sx={{ flex: 1 }} />
            <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              Today {fmtHours(liveHours(state, now))}
            </Typography>
          </Stack>

          {open ? (
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                {open.job.name}
              </Typography>
              <Typography color="text.secondary">
                {open.phase?.name ?? 'No phase'} · since {fmtTime(open.clockIn)} · {fmtElapsed(open.clockIn, now)}
              </Typography>
            </Box>
          ) : (
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </Typography>
          )}

          {open && state.phases.length > 0 && <PhaseTrack phases={state.phases} current={phaseIndex} />}
        </Stack>
      </Paper>

      {error && <Alert severity="error">{error}</Alert>}

      {picking && (
        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Autocomplete
              options={sortedJobs}
              value={job}
              onChange={(_, v) => setJob(v)}
              groupBy={(j) => KIND_LABEL[j.kind]}
              getOptionLabel={(j) => (j.code && !j.name.includes(j.code) ? `${j.code} ${j.name}` : j.name)}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              renderInput={(params) => <TextField {...params} label={switching ? 'Switch to job' : 'Job'} placeholder="Search by name or number" />}
              noOptionsText="No matching job"
            />
            <TextField select label="Phase" value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
              {state.phases.map((p) => (
                <MenuItem key={p.id} value={p.id}>
                  {p.name}
                </MenuItem>
              ))}
            </TextField>
            <Stack direction="row" spacing={1}>
              <Button
                fullWidth
                size="large"
                variant="contained"
                color={switching ? 'primary' : 'success'}
                disabled={busy || !job}
                onClick={() => job && act(() => api.punchIn(job.id, phaseId || undefined))}
                sx={{ py: 1.75, fontSize: 18 }}
              >
                {busy ? 'Recording…' : switching ? 'Switch' : 'Clock In'}
              </Button>
              {switching && (
                <Button onClick={() => setSwitching(false)} disabled={busy}>
                  Cancel
                </Button>
              )}
            </Stack>
          </Stack>
        </Paper>
      )}

      {state.onClock && !switching && (
        <Stack spacing={1}>
          {state.nextPhase && (
            <Button size="large" variant="contained" color="secondary" disabled={busy} onClick={() => act(() => api.punchNext())} sx={{ py: 2.25, fontSize: 20 }}>
              {busy ? 'Recording…' : `Next: ${state.nextPhase.name}`}
            </Button>
          )}
          <Stack direction="row" spacing={1}>
            <Button fullWidth size="large" variant="outlined" disabled={busy} onClick={() => setSwitching(true)}>
              Switch job
            </Button>
            <Button fullWidth size="large" variant={state.nextPhase ? 'outlined' : 'contained'} color="warning" disabled={busy} onClick={() => act(() => api.punchOut())}>
              Clock Out
            </Button>
          </Stack>
        </Stack>
      )}

      {state.today.length > 0 && (
        <Paper sx={{ p: 2 }}>
          <Typography variant="subtitle2" color="text.secondary" gutterBottom>
            Today
          </Typography>
          <Stack divider={<Divider flexItem />} spacing={1}>
            {state.today.map((p) => (
              <Stack key={p.id} direction="row" alignItems="baseline" spacing={1}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                    {p.phase?.short ?? '—'} · {p.job.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {fmtTime(p.clockIn)} – {p.clockOut ? fmtTime(p.clockOut) : 'now'}
                  </Typography>
                </Box>
                <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums' }} color={p.clockOut ? 'text.primary' : 'success.main'}>
                  {fmtElapsed(p.clockIn, p.clockOut ?? now)}
                </Typography>
              </Stack>
            ))}
          </Stack>
        </Paper>
      )}

      <Typography variant="caption" color="text.secondary" textAlign="center">
        Your location is recorded only at the moment you punch.
      </Typography>
    </Stack>
  )
}

/** Hours today, counting the open segment up to this minute. */
function liveHours(state: DayState, now: Date): number {
  return state.today.reduce((sum, p) => sum + Math.max(0, (new Date(p.clockOut ?? now).getTime() - new Date(p.clockIn).getTime()) / 3_600_000), 0)
}

function PhaseTrack({ phases, current }: { phases: Phase[]; current: number }) {
  return (
    <Box>
      <Stack direction="row" spacing={0.5}>
        {phases.map((p, i) => (
          <Box
            key={p.id}
            title={p.name}
            sx={{ flex: 1, height: 8, borderRadius: 4, bgcolor: i < current ? 'primary.main' : i === current ? 'secondary.main' : 'action.disabledBackground' }}
          />
        ))}
      </Stack>
      {current >= 0 && (
        <Typography variant="caption" color="text.secondary">
          Step {current + 1} of {phases.length}
        </Typography>
      )}
    </Box>
  )
}
