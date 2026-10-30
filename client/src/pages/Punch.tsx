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
  fmtMoney,
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
  type OpenItem,
  type Punch as Segment,
  type WorkMode,
} from '../api'
import { DayTimeline, jobColor, MODE_INFO, ModePicker, readMode, writeMode } from './modes'
import { ExpenseDialog } from './Expenses'
import { applyDecision, CloseOutDialog, DecisionBox, OpenItemsCard, type Decision } from './items'

// The clock screen. After sign-in the person picks what the day is: Install,
// Service, Office or Shop (kept on this phone for the day). Each mode offers its own
// phases and puts its own jobs first:
//   Install — the field day, one big "Next" button through the steps.
//   Service — Start drive (from home or the shop) → Arrived → Call complete →
//             drive to the next call, to the shop, or home.
//   Office  — one clock-in; switch projects and tasks with one tap; "Stop project"
//             keeps the clock running on unallocated time.
//   Shop    — a project plus a shop task (UCI, racks, prep, receiving), switched
//             through the day.
//   CAD     — a project plus a CAD task (design, line diagrams, racks, submittals).
// Service tickets and Shop / Office / CAD tasks stay open when the person switches
// away; Resume picks one back up, and clocking out for the day asks to close each.
// With no signal, taps are kept on the phone and the screen carries on as if they
// had gone through.

type Group = 'Today' | 'Projects' | 'Service' | 'Shop' | 'Repair' | 'Office'
const KIND_GROUP: Record<Job['kind'], Group> = { project: 'Projects', service: 'Service', shop: 'Shop', repair: 'Repair', other: 'Office' }
const MODE_GROUPS: Record<WorkMode, Group[]> = {
  install: ['Today', 'Projects', 'Shop', 'Service', 'Office'],
  service: ['Today', 'Service', 'Shop', 'Projects', 'Office'],
  office: ['Today', 'Projects', 'Office', 'Service', 'Shop'],
  shop: ['Today', 'Projects', 'Shop', 'Service', 'Office'],
  cad: ['Today', 'Projects', 'Office', 'Service', 'Shop'],
  // Bench Repair offers only the Electronic Repair tickets (see choices).
  bench: ['Repair'],
}
interface Choice {
  job: Job
  group: Group
  hint?: string
}

const OVERHEAD_CODE = 'OVERHEAD'
/** After this long on unallocated time, remind the person to pick a project. */
const UNALLOCATED_NUDGE_MIN = 30

const modeOfPhase = (p: Phase | null | undefined): WorkMode => (p?.mode && p.mode in MODE_INFO ? p.mode : 'install')

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

export default function PunchPage({ canCrew = false, meId = '', meName = '' }: { canCrew?: boolean; meId?: string; meName?: string }) {
  const [state, setState] = useState<DayState | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [choice, setChoice] = useState<Choice | null>(null)
  const [phaseId, setPhaseId] = useState('')
  const [note, setNote] = useState('')
  const [switching, setSwitching] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // The work mode picked on the start screen today (null = show the start screen).
  const [picked, setPicked] = useState<WorkMode | null>(() => readMode())
  const [choosingMode, setChoosingMode] = useState(false)
  // Service: what to do when a call is done.
  const [completing, setCompleting] = useState(false)
  // Close or leave open the service ticket when a call is complete.
  const [ticket, setTicket] = useState<Decision>({ choice: null, text: '' })
  // Clocking out with open items: break, or close them out for the day.
  const [closingOut, setClosingOut] = useState<OpenItem[] | null>(null)
  // Expense onto the current flight.
  const [expensing, setExpensing] = useState(false)
  const [expenseMsg, setExpenseMsg] = useState('')
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

  const pickMode = (m: WorkMode) => {
    writeMode(m)
    setPicked(m)
    setChoosingMode(false)
    setPhaseId('')
    setChoice(null)
  }

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

  // On the clock, the open segment's phase says which mode the person is in.
  const mode: WorkMode = state?.open?.phase ? modeOfPhase(state.open.phase) : picked ?? 'install'
  const modePhases = useMemo(() => (state?.phases ?? []).filter((p) => modeOfPhase(p) === mode), [state?.phases, mode])
  const phaseByKey = (key: string) => state?.phases.find((p) => p.key === key)

  const choices = useMemo<Choice[]>(() => {
    const order = MODE_GROUPS[mode]
    const scheduled = (state?.assignments ?? []).filter((a) => a.job)
    const seen = new Set<string>()
    const out: Choice[] = []
    for (const a of scheduled) {
      if (seen.has(a.job!.id)) continue
      seen.add(a.job!.id)
      out.push({ job: a.job!, group: 'Today', hint: [a.shopTime && `${a.shopTime} shop`, a.title].filter(Boolean).join(' · ') })
    }
    for (const j of jobs) if (!seen.has(j.id) && j.code !== OVERHEAD_CODE) out.push({ job: j, group: KIND_GROUP[j.kind] ?? 'Office' })
    // Repair tickets belong to Bench Repair, and Bench Repair offers nothing else.
    const fits = (c: Choice) => (mode === 'bench' ? c.job.kind === 'repair' : c.job.kind !== 'repair')
    const rank = (g: Group) => (order.indexOf(g) < 0 ? 99 : order.indexOf(g))
    return out.filter(fits).sort((a, b) => rank(a.group) - rank(b.group) || labelOf(a.job).localeCompare(labelOf(b.job)))
  }, [state?.assignments, jobs, mode])

  // Suggest a phase that belongs to the mode: where the day is up to, else the
  // phase last used in this mode today, else the mode's first.
  useEffect(() => {
    if (!state || !modePhases.length) return
    if (modePhases.some((p) => p.id === phaseId)) return
    const lastInMode = [...state.today].reverse().find((p) => p.phase && modeOfPhase(p.phase) === mode)?.phase
    const pick =
      (state.nextPhase && modeOfPhase(state.nextPhase) === mode ? state.nextPhase : null) ??
      (lastInMode && modePhases.find((p) => p.id === lastInMode.id)) ??
      modePhases[0]
    setPhaseId(pick.id)
  }, [state, modePhases, mode, phaseId])

  // Suggest a job: the one last worked today, else today's scheduled job, else the
  // job last punched on any earlier day. The tech can always change it.
  useEffect(() => {
    if (choice || !state || !choices.length) return
    const last = [...state.today].reverse().find((p) => p.job.code !== OVERHEAD_CODE) ?? null
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
      setCompleting(false)
      setClosingOut(null)
      setTicket({ choice: null, text: '' })
      setNote('')
      if (next.open?.phase) setPhaseId(next.open.phase.id)
      if (next.parallelRun ?? state.parallelRun) setMirror(kind)
      setCrewMsg(null)
      await punchCrew(kind, r.sent, next, local.job)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const clockIn = (job: Job, phase: string | undefined, notes?: string) => act('in', () => api.punchIn(job.id, phase, notes), { job, phaseId: phase })
  const toPhase = (phase: Phase) => act('next', () => api.punchNext(phase.id), { phaseId: phase.id })
  const punchOut = () => act('out', () => api.punchOut(), {})
  const openItems = state?.openItems ?? []
  // Clocking out with open tickets or tasks asks first: a break, or done for the day.
  // Items already left open with a reason (at Call complete, or earlier) are not asked again.
  const requestOut = (items: OpenItem[] = openItems) => {
    const pending = items.filter((i) => !i.waitingReason)
    if (pending.length) setClosingOut(pending)
    else void punchOut()
  }
  // Service, call complete: apply the ticket decision, then the next move.
  const withTicket = (next: (left: OpenItem[]) => unknown) => async () => {
    const current = openItems.find((i) => i.current)
    setBusy(true)
    try {
      if (current && (await applyDecision(current, ticket))) {
        const reason = ticket.text.trim()
        const left =
          ticket.choice === 'close'
            ? openItems.filter((i) => i.id !== current.id)
            : openItems.map((i) => (i.id === current.id ? { ...i, waitingReason: reason } : i))
        setState((s) => (s ? { ...s, openItems: left } : s))
        setBusy(false)
        return next(left)
      }
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
      return
    }
    setBusy(false)
    return next(openItems)
  }
  const resume = (item: OpenItem) => {
    const m = item.mode as WorkMode
    writeMode(m)
    setPicked(m)
    setSwitching(false)
    const first = (state?.phases ?? []).find((p) => modeOfPhase(p) === m && p.key !== 'admin-overhead')
    const phase = m === 'service' ? phaseByKey('svc-travel')?.id : item.lastPhaseId ?? first?.id
    void clockIn(item.job as Job, phase)
  }

  if (!state) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
        {error && <Button onClick={() => void load()}>Try again</Button>}
      </Stack>
    )
  }

  // A new day (or "Change"): the start screen.
  if ((!state.onClock && !picked) || choosingMode) {
    return (
      <Stack spacing={2}>
        <ModePicker name={meName} current={choosingMode ? mode : null} onPick={pickMode} />
        {choosingMode && (
          <Button onClick={() => setChoosingMode(false)} sx={{ alignSelf: 'center' }}>
            Cancel
          </Button>
        )}
        {state.onClock && choosingMode && (
          <Typography variant="body2" color="text.secondary" textAlign="center">
            You stay on the clock. The new mode starts with your next switch.
          </Typography>
        )}
      </Stack>
    )
  }

  const open = state.open
  const picking = !state.onClock || switching
  const onOverhead = open?.job.code === OVERHEAD_CODE
  // The step track shows the field day of this mode only.
  const flowPhases = modePhases.filter((p) => p.dayFlow !== false)
  const phaseIndex = open?.phase ? flowPhases.findIndex((p) => p.id === open.phase!.id) : -1
  const scheduledToday = (state.assignments ?? []).filter((a) => a.title)
  const recent = (state.recentJobs ?? []).filter((j) => j.id !== open?.jobId && (mode === 'bench') === (j.kind === 'repair')).slice(0, 6)
  const shopJob = jobs.find((j) => j.kind === 'shop' && j.code === 'SHOP') ?? jobs.find((j) => j.kind === 'shop')
  const svcTravel = phaseByKey('svc-travel')
  const svcOnsite = phaseByKey('svc-onsite')
  const svcParts = phaseByKey('svc-parts')
  const svcHome = phaseByKey('svc-home')
  const drivingHome = open?.phase?.key === 'svc-home'
  const back = !state.onClock ? state.lastSegment : null
  const pickedPhase = state.phases.find((p) => p.id === phaseId)
  const phaseLabel = mode === 'install' ? 'Phase' : 'Task'
  const taskMode = mode === 'office' || mode === 'shop' || mode === 'cad' || mode === 'bench'

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

      <Stack direction="row" alignItems="center" spacing={1}>
        <Chip label={`${MODE_INFO[mode].label} mode`} sx={{ fontWeight: 700, color: '#fff', bgcolor: MODE_INFO[mode].color }} />
        <Button size="small" onClick={() => setChoosingMode(true)}>
          Change
        </Button>
      </Stack>

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
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 1.6 }}>
                {onOverhead ? 'Unallocated time' : drivingHome ? 'Driving home' : 'Current flight'}
              </Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                <Box sx={{ width: 12, height: 12, borderRadius: '3px', flex: 'none', bgcolor: jobColor(open.jobId, open.job.code) }} />
                <Typography variant="h5" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
                  {open.job.name}
                </Typography>
              </Stack>
              <Typography color="text.secondary">
                {open.phase?.name ?? 'No phase'} · since {fmtTime(open.clockIn)} · {fmtElapsed(open.clockIn, now)}
              </Typography>
              {open.notes && (
                <Typography variant="body2" color="text.secondary">
                  {open.notes}
                </Typography>
              )}
              <SiteLine job={open.job} />
            </Box>
          ) : (
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              {now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
            </Typography>
          )}

          {open && phaseIndex >= 0 && flowPhases.length > 1 && <PhaseTrack phases={flowPhases} current={phaseIndex} />}

          {open && !onOverhead && (
            <Button variant="outlined" size="small" onClick={() => setExpensing(true)} sx={{ alignSelf: 'flex-start' }}>
              + Expense on this flight
            </Button>
          )}

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
      {expenseMsg && (
        <Alert severity="success" onClose={() => setExpenseMsg('')}>
          {expenseMsg}
        </Alert>
      )}
      <ExpenseDialog
        open={expensing}
        flight={open ? { jobId: open.jobId, jobName: open.job.name } : null}
        onClose={() => setExpensing(false)}
        onSaved={(e) => setExpenseMsg(`${e.category.name} ${fmtMoney(e.amount)} added to ${e.job?.name ?? 'your expenses'} and sent for approval.`)}
      />

      {onOverhead && open && (now.getTime() - new Date(open.clockIn).getTime()) / 60_000 >= UNALLOCATED_NUDGE_MIN && (
        <Alert severity="info">
          You have been on unallocated time for {fmtElapsed(open.clockIn, now)}. Pick a project when you start on one, so the hours land on the right
          job.
        </Alert>
      )}

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

      {/* Back from a break: one tap returns to what you were on. */}
      {back && back.job.active !== false && back.job.code !== OVERHEAD_CODE && (
        <Button
          size="large"
          variant="contained"
          color="success"
          disabled={busy}
          onClick={() => void clockIn(back.job, back.phaseId ?? undefined)}
          sx={{ py: 1.75, fontSize: 17 }}
        >
          Back to {back.job.name}
          {back.phase ? ` · ${back.phase.short}` : ''}
        </Button>
      )}

      <OpenItemsCard items={openItems} busy={busy} onResume={resume} />

      {picking && (
        <Paper sx={{ p: 2 }}>
          <Stack spacing={2}>
            <TextField
              label="Notes"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={mode === 'service' ? 'Ticket #, problem, what the customer said' : 'What you are working on'}
              multiline
              maxRows={4}
              inputProps={{ maxLength: 500 }}
            />
            <Autocomplete
              options={choices}
              value={choice}
              onChange={(_, v) => setChoice(v)}
              groupBy={(c) => (c.group === 'Today' ? "Today's schedule" : c.group === 'Repair' ? 'Repair tickets' : c.group)}
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
              renderInput={(params) => (
                <TextField
                  {...params}
                  label={mode === 'service' ? (switching ? 'Switch to call' : 'Service call') : mode === 'bench' ? (switching ? 'Switch to repair ticket' : 'Repair ticket') : switching ? 'Switch to job' : 'Job'}
                  placeholder={mode === 'bench' ? 'SD number, customer or unit' : 'Search by name or number'}
                />
              )}
              noOptionsText={mode === 'bench' ? 'No open repair ticket matches. Units are checked in at the Service Dept. first.' : 'No matching job'}
            />
            <SiteLine job={choice?.job} />
            {mode !== 'service' && (
              <TextField select label={phaseLabel} value={modePhases.some((p) => p.id === phaseId) ? phaseId : ''} onChange={(e) => setPhaseId(e.target.value)}>
                {modePhases.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {mode === 'service' && svcTravel && svcOnsite ? (
              <Stack spacing={0.75}>
              <Stack direction="row" spacing={1}>
                <Button fullWidth size="large" variant="contained" color="primary" disabled={busy || !choice} onClick={() => choice && void clockIn(choice.job, svcTravel.id, note)} sx={{ py: 1.75, fontSize: 17 }}>
                  {busy ? 'Recording…' : 'Start drive'}
                </Button>
                <Button fullWidth size="large" variant="outlined" disabled={busy || !choice} onClick={() => choice && void clockIn(choice.job, svcOnsite.id, note)} sx={{ py: 1.75 }}>
                  Already on site
                </Button>
              </Stack>
              {!switching && (
                <Typography variant="caption" color="text.secondary">
                  Start the drive when you leave, from home or the shop. Drive time is paid.
                </Typography>
              )}
              </Stack>
            ) : (
              <Button
                fullWidth
                size="large"
                variant="contained"
                color={switching ? 'primary' : 'success'}
                disabled={busy || !choice}
                onClick={() => choice && void clockIn(choice.job, pickedPhase?.id, note)}
                sx={{ py: 1.75, fontSize: 18 }}
              >
                {busy ? 'Recording…' : switching ? 'Switch' : 'Clock In'}
              </Button>
            )}
            {switching && (
              <Button onClick={() => setSwitching(false)} disabled={busy}>
                Cancel
              </Button>
            )}
          </Stack>
        </Paper>
      )}

      {state.onClock && !switching && open && (
        <Stack spacing={1}>
          {/* Install: one big button through the field day. */}
          {mode === 'install' && state.nextPhase && (
            <Button size="large" variant="contained" color="secondary" disabled={busy} onClick={() => act('next', () => api.punchNext(), {})} sx={{ py: 2.25, fontSize: 20 }}>
              {busy ? 'Recording…' : `Next: ${state.nextPhase.name}`}
            </Button>
          )}

          {/* Service: drive, arrive, complete. */}
          {mode === 'service' && open.phase?.key === 'svc-travel' && svcOnsite && (
            <>
              <Button size="large" variant="contained" color="secondary" disabled={busy} onClick={() => void toPhase(svcOnsite)} sx={{ py: 2.25, fontSize: 20 }}>
                {busy ? 'Recording…' : 'Arrived'}
              </Button>
              {svcParts && (
                <Button variant="outlined" disabled={busy} onClick={() => void toPhase(svcParts)}>
                  Parts / supply stop
                </Button>
              )}
            </>
          )}
          {mode === 'service' && open.phase?.key === 'svc-parts' && svcTravel && (
            <Button size="large" variant="contained" color="secondary" disabled={busy} onClick={() => void toPhase(svcTravel)} sx={{ py: 2.25, fontSize: 20 }}>
              {busy ? 'Recording…' : 'Back on the road'}
            </Button>
          )}
          {mode === 'service' && drivingHome && (
            <Button size="large" variant="contained" color="warning" disabled={busy} onClick={() => requestOut()} sx={{ py: 2.25, fontSize: 20 }}>
              {busy ? 'Recording…' : 'Home · Clock out'}
            </Button>
          )}
          {mode === 'service' && !drivingHome && open.phase?.key !== 'svc-travel' && open.phase?.key !== 'svc-parts' && (
            <Button
              size="large"
              variant="contained"
              color="secondary"
              disabled={busy}
              onClick={() => {
                // Offer the next call on today's schedule.
                setChoice(choices.find((c) => c.group === 'Today' && c.job.kind === 'service' && c.job.id !== open.jobId) ?? null)
                setTicket({ choice: null, text: '' })
                setCompleting(true)
              }}
              sx={{ py: 2.25, fontSize: 20 }}
            >
              Call complete
            </Button>
          )}

          {/* Office, Shop and CAD: tasks and jobs one tap away. */}
          {taskMode && (!onOverhead || recent.length > 0) && (
            <Paper sx={{ p: 1.5 }}>
              {!onOverhead && (
                <>
                  <Typography variant="caption" color="text.secondary">
                    Switch task on {open.job.name}
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1} sx={{ mt: 0.5, mb: 1.5 }}>
                    {modePhases
                      .filter((p) => p.key !== 'admin-overhead')
                      .map((p) => (
                        <Chip
                          key={p.id}
                          label={p.short}
                          color={p.id === open.phaseId ? 'primary' : 'default'}
                          variant={p.id === open.phaseId ? 'filled' : 'outlined'}
                          disabled={busy}
                          onClick={() => p.id !== open.phaseId && void toPhase(p)}
                        />
                      ))}
                  </Stack>
                </>
              )}
              {recent.length > 0 && (
                <>
                  <Typography variant="caption" color="text.secondary" component="div">
                    {onOverhead ? 'Back to a project' : 'Switch job (keeps the task)'}
                  </Typography>
                  <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1} sx={{ mt: 0.5 }}>
                    {recent.map((j) => (
                      <Chip
                        key={j.id}
                        label={labelOf(j)}
                        variant="outlined"
                        disabled={busy}
                        icon={<Box component="span" sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: jobColor(j.id, j.code), ml: '10px !important', flex: 'none' }} />}
                        onClick={() => {
                          const work = modePhases.filter((p) => p.key !== 'admin-overhead')
                          const keep = open.phase && work.some((p) => p.id === open.phase!.id) ? open.phase.id : work[0]?.id
                          void clockIn(j, keep)
                        }}
                      />
                    ))}
                  </Stack>
                </>
              )}
            </Paper>
          )}

          <Stack direction="row" spacing={1} sx={{ '& .MuiButton-root': { whiteSpace: 'nowrap', px: 1 } }}>
            <Button fullWidth size="large" variant="outlined" disabled={busy} onClick={() => setSwitching(true)}>
              {mode === 'service' ? 'Switch call' : mode === 'bench' ? 'Switch ticket' : 'Switch job'}
            </Button>
            {(mode === 'office' || mode === 'shop') && state.overhead && !onOverhead && (
              <Button
                fullWidth
                size="large"
                variant="outlined"
                disabled={busy}
                onClick={() => void clockIn(state.overhead!.job, state.overhead!.phase?.id ?? undefined)}
                title="Stay on the clock; the time goes to unallocated / overhead"
              >
                Stop project
              </Button>
            )}
            <Button
              fullWidth
              size="large"
              variant={mode === 'install' && state.nextPhase ? 'outlined' : 'contained'}
              color="warning"
              disabled={busy}
              onClick={() => requestOut()}
            >
              {mode === 'install' ? 'Clock Out' : 'Break / Out'}
            </Button>
          </Stack>
        </Stack>
      )}

      <Dialog open={completing} onClose={() => setCompleting(false)} fullWidth maxWidth="xs">
        <DialogTitle>Call complete. Where to next?</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={1.5}>
            {openItems.some((i) => i.current) && (
              <>
                <Typography variant="subtitle2">The ticket for {open?.job.name}</Typography>
                <DecisionBox item={{ mode: 'service' }} value={ticket} onChange={setTicket} />
                <Typography variant="caption" color="text.secondary">
                  Leave it open and it stays on your list to pick back up.
                </Typography>
                <Divider />
              </>
            )}
            <Autocomplete
              options={choices.filter((c) => c.job.id !== open?.jobId)}
              value={choice && choice.job.id !== open?.jobId ? choice : null}
              onChange={(_, v) => setChoice(v)}
              groupBy={(c) => (c.group === 'Today' ? "Today's schedule" : c.group === 'Repair' ? 'Repair tickets' : c.group)}
              getOptionLabel={(c) => labelOf(c.job)}
              isOptionEqualToValue={(a, b) => a.job.id === b.job.id}
              renderInput={(params) => <TextField {...params} label="Next service call" placeholder="Search by name or ticket" />}
            />
            <Button
              size="large"
              variant="contained"
              disabled={busy || !choice || choice.job.id === open?.jobId || !svcTravel}
              onClick={withTicket(() => choice && svcTravel && clockIn(choice.job, svcTravel.id))}
            >
              Drive to next call
            </Button>
            <Typography variant="caption" color="text.secondary">
              The drive is charged to the call you are heading to.
            </Typography>
            <Divider />
            {shopJob && svcTravel && (
              <Button variant="outlined" disabled={busy} onClick={withTicket(() => clockIn(shopJob, svcTravel.id))}>
                Drive to shop
              </Button>
            )}
            {svcHome && (
              <Button variant="outlined" disabled={busy} onClick={withTicket(() => toPhase(svcHome))}>
                Drive home
              </Button>
            )}
            <Typography variant="caption" color="text.secondary">
              Drives to the shop or home are paid and never billed to the customer.
            </Typography>
            <Button variant="outlined" color="warning" disabled={busy} onClick={withTicket((left) => (setCompleting(false), requestOut(left)))}>
              Clock out
            </Button>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCompleting(false)}>Not yet</Button>
        </DialogActions>
      </Dialog>

      <CloseOutDialog
        open={closingOut !== null}
        items={closingOut ?? []}
        alreadyLeft={openItems.filter((i) => i.waitingReason)}
        onCancel={() => setClosingOut(null)}
        onBreak={() => void punchOut()}
        onDone={() => void punchOut()}
      />

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
          <Box sx={{ mb: 1.5 }}>
            <DayTimeline segments={state.today} now={now} />
          </Box>
          <Stack divider={<Divider flexItem />} spacing={1}>
            {state.today.map((p) => (
              <Stack key={p.id} direction="row" alignItems="baseline" spacing={1}>
                <Box sx={{ width: 8, height: 8, borderRadius: '2px', flex: 'none', alignSelf: 'center', bgcolor: jobColor(p.jobId, p.job.code) }} />
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                    {p.phase?.short ?? '—'} · {p.job.name}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">
                    {fmtTime(p.clockIn)} – {p.clockOut ? fmtTime(p.clockOut) : 'now'}
                    {p.notes && ` · ${p.notes}`}
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
        ? s.phases.find((p) => p.id === o.phaseId) ?? s.nextPhase
        : s.phases.find((p) => p.id === o.phaseId) ?? s.phases[0] ?? null
    if (job) {
      open = { id: `local-${o.at}`, personId: '', jobId: job.id, phaseId: phase?.id ?? null, clockIn: o.at, clockOut: null, notes: '', job, phase }
      today.push(open)
    }
  }
  // Same rule as the server: "Next" steps through the field day of one mode only.
  const after = open?.phase?.sortOrder ?? -1
  const openMode = modeOfPhase(open?.phase)
  const last = today.length ? today[today.length - 1] : null
  const flow = s.phases.filter((p) => p.dayFlow !== false)
  const nextPhase = open
    ? open.phase && open.phase.dayFlow === false
      ? null
      : flow.find((p) => modeOfPhase(p) === openMode && p.sortOrder > after) ?? null
    : s.phases.find((p) => p.id === last?.phaseId) ?? flow[0] ?? s.phases[0] ?? null
  const hoursToday = today.reduce((sum, p) => sum + Math.max(0, (new Date(p.clockOut ?? o.at).getTime() - new Date(p.clockIn).getTime()) / 3_600_000), 0)
  return { ...s, onClock: Boolean(open), open, today, nextPhase, hoursToday, lastSegment: open ? null : last }
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
