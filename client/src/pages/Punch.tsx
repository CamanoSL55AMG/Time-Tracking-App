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
  Divider,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  TextField,
  Typography,
} from '@mui/material'
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
  type CrewResult,
  type DayState,
  type Job,
  type Person,
  type Phase,
  type PunchKind,
  type PunchOutcome,
  type Punch as Segment,
} from '../api'

// The tech's screen. Off the clock: pick the job (today's schedule is offered
// first), tap Clock In. On the clock: one big button moves to the next phase of the
// day; Switch job and Clock Out sit under it. With no signal, taps are kept on the
// phone and the screen carries on as if they had gone through.

type Group = 'Today' | 'Projects' | 'Service' | 'Shop' | 'Office'
const KIND_GROUP: Record<Job['kind'], Group> = { project: 'Projects', service: 'Service', shop: 'Shop', other: 'Office' }
const GROUP_ORDER: Group[] = ['Today', 'Projects', 'Service', 'Shop', 'Office']
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

// A crew lead's crew, remembered on this phone.
const CREW_KEY = 'tt_crew'
const readCrew = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(CREW_KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []
  } catch {
    return []
  }
}
const writeCrew = (ids: string[]) => {
  try {
    localStorage.setItem(CREW_KEY, JSON.stringify(ids))
  } catch {
    /* storage blocked: the crew is kept for this visit only */
  }
}

export default function PunchPage({ canCrew = false, meId = '' }: { canCrew?: boolean; meId?: string }) {
  const [state, setState] = useState<DayState | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [choice, setChoice] = useState<Choice | null>(null)
  const [phaseId, setPhaseId] = useState('')
  const [switching, setSwitching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Which punch to repeat in Timesheets.com, shown after each punch during the parallel run.
  const [mirror, setMirror] = useState<PunchKind | null>(null)
  const now = useNow(15_000)
  const queue = useQueue()
  // Crew punch: the lead's taps also punch the crew, with the same job and phase.
  const [crewIds, setCrewIds] = useState<string[]>(() => (canCrew ? readCrew() : []))
  const [crewOn, setCrewOn] = useState(false)
  const [crewPick, setCrewPick] = useState(false)
  const [people, setPeople] = useState<Person[]>([])
  const [crewMsg, setCrewMsg] = useState<{ severity: 'success' | 'warning'; text: string } | null>(null)

  useEffect(() => {
    if (canCrew) api.people().then((p) => setPeople(p.filter((x) => x.active && x.id !== meId)), () => undefined)
  }, [canCrew, meId])
  const crewNames = crewIds.map((id) => people.find((p) => p.id === id)?.name).filter(Boolean) as string[]

  const punchCrew = async (kind: PunchKind, sent: boolean, next: DayState, job?: Job) => {
    if (!crewOn || !crewIds.length) return
    if (!sent) {
      setCrewMsg({ severity: 'warning', text: 'No signal, so your crew was not punched. Punch them once the signal is back.' })
      return
    }
    try {
      const r = await api.crew(kind, {
        personIds: crewIds,
        jobId: kind === 'in' ? job?.id : undefined,
        phaseId: kind === 'out' ? undefined : next.open?.phaseId ?? undefined,
      })
      setCrewMsg(crewSummary(r.results))
    } catch (err) {
      setCrewMsg({ severity: 'warning', text: `Your crew was not punched: ${errorText(err)}` })
    }
  }

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

  // Suggest a job: the one last worked today, else today's scheduled job, else the
  // job last punched on any earlier day. The tech can always change it.
  useEffect(() => {
    if (choice || !state || !choices.length) return
    const last = state.today.length ? state.today[state.today.length - 1] : null
    const pick =
      (last && choices.find((c) => c.job.id === last.jobId)) ||
      choices.find((c) => c.group === 'Today') ||
      (state.lastJob && choices.find((c) => c.job.id === state.lastJob!.id))
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
      if (next.parallelRun ?? state.parallelRun) setMirror(kind)
      setCrewMsg(null)
      await punchCrew(kind, r.sent, next, local.job)
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
  // The step track shows the field day only; office phases are not steps in it.
  const flowPhases = state.phases.filter((p) => p.dayFlow !== false)
  const phaseIndex = open?.phase ? flowPhases.findIndex((p) => p.id === open.phase!.id) : -1
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
              <SiteLine job={open.job} />
            </Box>
          ) : (
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </Typography>
          )}

          {open && phaseIndex >= 0 && <PhaseTrack phases={flowPhases} current={phaseIndex} />}

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

      {mirror && state.parallelRun && (
        <Alert
          severity="warning"
          onClose={() => setMirror(null)}
          action={
            <Button color="inherit" variant="outlined" size="small" href={state.parallelRun.url} target="_blank" rel="noopener" onClick={() => setMirror(null)}>
              Open Timesheets
            </Button>
          }
        >
          <strong>{mirror === 'out' ? 'Now clock out in Timesheets.com too.' : mirror === 'next' ? 'Now switch your task in Timesheets.com too.' : 'Now clock in to Timesheets.com too.'}</strong>{' '}
          Payroll still runs from Timesheets.com until {fmtUntil(state.parallelRun.until)}.
        </Alert>
      )}

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
            <SiteLine job={choice?.job} />
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

      {crewMsg && (
        <Alert severity={crewMsg.severity} onClose={() => setCrewMsg(null)}>
          {crewMsg.text}
        </Alert>
      )}

      {canCrew && (
        <Paper sx={{ p: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <FormControlLabel
              sx={{ flex: 1, mr: 0 }}
              control={<Switch checked={crewOn && crewIds.length > 0} disabled={!crewIds.length} onChange={(e) => setCrewOn(e.target.checked)} />}
              label={crewIds.length ? `Punch my crew too (${crewIds.length})` : 'Punch my crew too'}
            />
            <Button size="small" onClick={() => setCrewPick(true)}>
              {crewIds.length ? 'Edit crew' : 'Pick crew'}
            </Button>
          </Stack>
          {crewNames.length > 0 && (
            <Typography variant="caption" color="text.secondary">
              {crewNames.join(', ')}
            </Typography>
          )}
        </Paper>
      )}

      <Dialog open={crewPick} onClose={() => setCrewPick(false)} fullWidth maxWidth="xs">
        <DialogTitle>Your crew</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            With "Punch my crew too" on, each of your punches also clocks these people in, to the same phase, or out.
          </Typography>
          <Stack>
            {people.map((p) => (
              <FormControlLabel
                key={p.id}
                control={
                  <Checkbox
                    checked={crewIds.includes(p.id)}
                    onChange={(e) => {
                      const next = e.target.checked ? [...crewIds, p.id] : crewIds.filter((x) => x !== p.id)
                      setCrewIds(next)
                      writeCrew(next)
                    }}
                  />
                }
                label={p.name}
              />
            ))}
            {!people.length && <Typography color="text.secondary">Loading people…</Typography>}
          </Stack>
        </DialogContent>
        <DialogActions>
          {crewIds.length > 0 && (
            <Button
              onClick={() => {
                setCrewIds([])
                writeCrew([])
              }}
            >
              Clear
            </Button>
          )}
          <Box sx={{ flex: 1 }} />
          <Button
            variant="contained"
            onClick={() => {
              setCrewPick(false)
              if (crewIds.length) setCrewOn(true)
            }}
          >
            Done
          </Button>
        </DialogActions>
      </Dialog>

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

/** One line for the lead: who was punched, who was not and why. */
function crewSummary(results: CrewResult[]): { severity: 'success' | 'warning'; text: string } {
  const ok = results.filter((r) => r.ok)
  const bad = results.filter((r) => !r.ok)
  const first = (n: string) => n.split(' ')[0]
  if (!bad.length) return { severity: 'success', text: `Crew punched: ${ok.map((r) => first(r.name)).join(', ')}.` }
  return {
    severity: 'warning',
    text: `${ok.length ? `Crew punched: ${ok.map((r) => first(r.name)).join(', ')}. ` : ''}Not punched: ${bad.map((r) => `${r.name || 'unknown'} (${r.message})`).join('; ')}`,
  }
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
  // Same rule as the server: "Next" steps through the field day only.
  const after = open?.phase?.sortOrder ?? -1
  const last = today.length ? today[today.length - 1] : null
  const flow = s.phases.filter((p) => p.dayFlow !== false)
  const nextPhase = open
    ? open.phase && open.phase.dayFlow === false
      ? null
      : flow.find((p) => p.sortOrder > after) ?? null
    : s.phases.find((p) => p.id === last?.phaseId) ?? flow[0] ?? s.phases[0] ?? null
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

/** The job site's address with a link that opens directions in the phone's maps app. */
function SiteLine({ job }: { job: Job | null | undefined }) {
  const address = job?.siteAddress?.trim()
  if (!address) return null
  const href = `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address)}`
  return (
    <Typography variant="body2" color="text.secondary">
      {address} ·{' '}
      <Box component="a" href={href} target="_blank" rel="noopener" sx={{ color: 'primary.main', fontWeight: 600 }}>
        Directions
      </Box>
    </Typography>
  )
}

/** "2026-12-31" -> "Dec 31". */
function fmtUntil(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00`)
  return Number.isNaN(d.getTime()) ? ymd : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
}
