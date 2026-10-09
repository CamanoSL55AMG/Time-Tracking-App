import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Autocomplete, Box, Button, Chip, CircularProgress, Divider, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material'
import {
  api,
  clearFailedPunches,
  errorText,
  failedPunches,
  flushPunches,
  fmtElapsed,
  fmtHours,
  fmtTime,
  onQueueChange,
  queuedPunches,
  type DayState,
  type Job,
  type Phase,
  type PunchKind,
  type PunchOutcome,
  type Punch as Segment,
} from '../api'

// The tech's screen. Off the clock: pick the job (today's schedule is offered
// first), tap Clock In. On the clock: one big button moves to the next phase of the
// day; Switch job and Clock Out sit under it. With no signal, taps are kept on the
// phone and the screen carries on as if they had gone through.

type Group = 'Today' | 'Projects' | 'Service' | 'Shop' | 'Other'
const KIND_GROUP: Record<Job['kind'], Group> = { project: 'Projects', service: 'Service', shop: 'Shop', other: 'Other' }
const GROUP_ORDER: Group[] = ['Today', 'Projects', 'Service', 'Shop', 'Other']
interface Choice {
  job: Job
  group: Group
  hint?: string
}

const useNow = (everyMs: number) => {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), everyMs)
    return () => clearInterval(t)
  }, [everyMs])
  return now
}

const useQueue = () => {
  const [, bump] = useState(0)
  useEffect(() => onQueueChange(() => bump((n) => n + 1)), [])
  return { waiting: queuedPunches().length, failed: failedPunches() }
}

const labelOf = (j: Job) => (j.kind === 'project' && j.code && !j.name.includes(j.code) ? `${j.code} ${j.name}` : j.name)

export default function PunchPage() {
  const [state, setState] = useState<DayState | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [choice, setChoice] = useState<Choice | null>(null)
  const [phaseId, setPhaseId] = useState('')
  const [switching, setSwitching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const now = useNow(15_000)
  const queue = useQueue()

  const load = useCallback(async () => {
    // While punches are waiting on this phone, the server's view is behind ours.
    if (queuedPunches().length) return
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
    void flushPunches().then(() => load())
    const onFocus = () => void flushPunches().then(() => load())
    window.addEventListener('focus', onFocus)
    const t = setInterval(() => void load(), 60_000)
    return () => {
      window.removeEventListener('focus', onFocus)
      clearInterval(t)
    }
  }, [load])

  // When the last waiting punch goes through, show the server's version again.
  useEffect(() => {
    if (queue.waiting === 0) void load()
  }, [queue.waiting, load])

  const choices = useMemo<Choice[]>(() => {
    const scheduled = (state?.assignments ?? []).filter((a) => a.job)
    const seen = new Set<string>()
    const out: Choice[] = []
    for (const a of scheduled) {
      if (seen.has(a.job!.id)) continue
      seen.add(a.job!.id)
      out.push({ job: a.job!, group: 'Today', hint: [a.shopTime && `${a.shopTime} shop`, a.title].filter(Boolean).join(' · ') })
    }
    for (const j of jobs) if (!seen.has(j.id)) out.push({ job: j, group: KIND_GROUP[j.kind] })
    return out.sort((a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group) || labelOf(a.job).localeCompare(labelOf(b.job)))
  }, [state?.assignments, jobs])

  // Suggest the phase the day is up to; the tech can change it.
  useEffect(() => {
    if (state && !phaseId) setPhaseId(state.nextPhase?.id ?? state.phases[0]?.id ?? '')
  }, [state, phaseId])

  // Suggest a job: the one last worked today, else today's scheduled job.
  useEffect(() => {
    if (choice || !state || !choices.length) return
    const last = state.today.length ? state.today[state.today.length - 1] : null
    const pick = (last && choices.find((c) => c.job.id === last.jobId)) || choices.find((c) => c.group === 'Today')
    if (pick) setChoice(pick)
  }, [state, choices, choice])

  const act = async (kind: PunchKind, run: () => Promise<PunchOutcome>, local: { job?: Job; phaseId?: string }) => {
    if (!state) return
    setBusy(true)
    setError('')
    try {
      const r = await run()
      const next = r.sent ? r.state : simulate(state, kind, { ...local, at: r.at })
      setState(next)
      setSwitching(false)
      setPhaseId(next.nextPhase?.id ?? '')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

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
  const scheduledToday = (state.assignments ?? []).filter((a) => a.title)

  return (
    <Stack spacing={2}>
      {queue.waiting > 0 && (
        <Alert severity="info">
          {queue.waiting === 1 ? '1 punch is' : `${queue.waiting} punches are`} saved on this phone and will be sent when the signal comes back. The
          times are kept as you tapped them.
        </Alert>
      )}
      {queue.failed.length > 0 && (
        <Alert severity="warning" onClose={clearFailedPunches}>
          {queue.failed.length === 1 ? 'A punch saved without signal' : 'Some punches saved without signal'} could not be recorded. Tell your manager so it
          can be fixed:
          {queue.failed.map((m) => (
            <Box key={m} component="span" sx={{ display: 'block' }}>
              {m}
            </Box>
          ))}
        </Alert>
      )}

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

          {!state.onClock && scheduledToday.length > 0 && (
            <Box>
              <Typography variant="caption" color="text.secondary">
                On the job calendar today
              </Typography>
              {scheduledToday.map((a) => (
                <Typography key={a.id} variant="body2" sx={{ fontWeight: 600 }}>
                  {a.title}
                </Typography>
              ))}
            </Box>
          )}
        </Stack>
      </Paper>

      {error && <Alert severity="error">{error}</Alert>}

      {picking && (
        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            <Autocomplete
              options={choices}
              value={choice}
              onChange={(_, v) => setChoice(v)}
              groupBy={(c) => (c.group === 'Today' ? "Today's schedule" : c.group)}
              getOptionLabel={(c) => labelOf(c.job)}
              isOptionEqualToValue={(a, b) => a.job.id === b.job.id}
              renderOption={(props, c) => {
                const { key, ...rest } = props as typeof props & { key: string }
                return (
                  <li key={key} {...rest}>
                    <Box>
                      <Typography variant="body2">{labelOf(c.job)}</Typography>
                      {c.hint && (
                        <Typography variant="caption" color="text.secondary">
                          {c.hint}
                        </Typography>
                      )}
                    </Box>
                  </li>
                )
              }}
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
                disabled={busy || !choice}
                onClick={() => choice && act('in', () => api.punchIn(choice.job.id, phaseId || undefined), { job: choice.job, phaseId })}
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
            <Button size="large" variant="contained" color="secondary" disabled={busy} onClick={() => act('next', () => api.punchNext(), {})} sx={{ py: 2.25, fontSize: 20 }}>
              {busy ? 'Recording…' : `Next: ${state.nextPhase.name}`}
            </Button>
          )}
          <Stack direction="row" spacing={1}>
            <Button fullWidth size="large" variant="outlined" disabled={busy} onClick={() => setSwitching(true)}>
              Switch job
            </Button>
            <Button
              fullWidth
              size="large"
              variant={state.nextPhase ? 'outlined' : 'contained'}
              color="warning"
              disabled={busy}
              onClick={() => act('out', () => api.punchOut(), {})}
            >
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
                    {p.id.startsWith('local-') && ' · not sent yet'}
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

/** What the server will say once a waiting punch reaches it, worked out on the phone. */
function simulate(s: DayState, kind: PunchKind, o: { job?: Job; phaseId?: string; at: string }): DayState {
  const today: Segment[] = s.today.map((p) => (p.clockOut ? p : { ...p, clockOut: o.at }))
  let open: Segment | null = null
  if (kind !== 'out') {
    const job = kind === 'next' ? s.open?.job : o.job
    const phase =
      kind === 'next'
        ? s.nextPhase
        : s.phases.find((p) => p.id === o.phaseId) ?? s.phases[0] ?? null
    if (job) {
      open = { id: `local-${o.at}`, personId: '', jobId: job.id, phaseId: phase?.id ?? null, clockIn: o.at, clockOut: null, notes: '', job, phase }
      today.push(open)
    }
  }
  const after = open?.phase?.sortOrder ?? -1
  const last = today.length ? today[today.length - 1] : null
  const nextPhase = open ? s.phases.find((p) => p.sortOrder > after) ?? null : s.phases.find((p) => p.id === last?.phaseId) ?? s.phases[0] ?? null
  const hoursToday = today.reduce((sum, p) => sum + Math.max(0, (new Date(p.clockOut ?? o.at).getTime() - new Date(p.clockIn).getTime()) / 3_600_000), 0)
  return { ...s, onClock: Boolean(open), open, today, nextPhase, hoursToday }
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
