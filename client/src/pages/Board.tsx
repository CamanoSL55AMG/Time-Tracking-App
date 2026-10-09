import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { api, errorText, fmtElapsed, fmtTime, grabGeo, type Board, type Job, type Person, type Phase, type PunchKind } from '../api'

// Tower board: who is on the clock, on which job, in which phase, since when.

export default function BoardPage({ canCrew = false }: { canCrew?: boolean }) {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [crewOpen, setCrewOpen] = useState(false)

  const load = useCallback(async () => {
    try {
      setBoard(await api.board())
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
    setNow(new Date())
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  if (!board) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
        {error && <Button onClick={() => void load()}>Try again</Button>}
      </Stack>
    )
  }

  const on = board.rows.filter((r) => r.onClock)
  const off = board.rows.filter((r) => !r.onClock)

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip color="success" label={`${on.length} on the clock`} sx={{ fontWeight: 700 }} />
        <Chip variant="outlined" label={`${off.length} done for now`} />
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          as of {fmtTime(board.asOf)}
        </Typography>
        {canCrew && (
          <Button variant="contained" color="secondary" onClick={() => setCrewOpen(true)}>
            Crew punch
          </Button>
        )}
      </Stack>
      {error && <Alert severity="warning">{error}</Alert>}
      {board.rows.length === 0 && <Typography color="text.secondary">Nobody has punched today.</Typography>}

      {board.rows.map((r) => (
        <Paper key={r.personId} sx={{ p: 1.75, opacity: r.onClock ? 1 : 0.65 }}>
          <Stack direction="row" spacing={1.5} alignItems="flex-start">
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, mt: 0.9, bgcolor: r.onClock ? 'success.main' : 'text.disabled' }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
                  {r.name}
                </Typography>
                {r.phaseName && (
                  <Chip
                    size="small"
                    color={r.onClock ? 'secondary' : 'default'}
                    variant={r.onClock ? 'filled' : 'outlined'}
                    label={r.phaseIndex !== null ? `${r.phaseIndex + 1}/${board.phaseCount} ${r.phaseName}` : r.phaseName}
                    sx={{ maxWidth: '60%', flexShrink: 0 }}
                  />
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary" noWrap>
                {[r.jobName || '—', r.atShop === true ? 'at the shop' : r.atShop === false ? 'away from the shop' : ''].filter(Boolean).join(' · ')}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {r.onClock ? `since ${fmtTime(r.since)} · ${fmtElapsed(r.since, now)}` : `out ${fmtTime(r.lastOut)}`} · {r.hoursToday.toFixed(1)} h today
              </Typography>
            </Box>
          </Stack>
        </Paper>
      ))}

      {crewOpen && (
        <CrewDialog
          onClose={(done) => {
            setCrewOpen(false)
            if (done) void load()
          }}
        />
      )}
    </Stack>
  )
}

// ─── Crew punch ─────────────────────────────────────────────────────────────
// A lead clocks the whole crew in, moves them to the next phase, or clocks them
// out, in one go. Each person's punch is recorded as entered by the lead.

function CrewDialog({ onClose }: { onClose: (done: boolean) => void }) {
  const [people, setPeople] = useState<Person[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [phases, setPhases] = useState<Phase[]>([])
  const [crew, setCrew] = useState<Person[]>([])
  const [action, setAction] = useState<PunchKind>('in')
  const [job, setJob] = useState<Job | null>(null)
  const [phaseId, setPhaseId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<string[] | null>(null)

  useEffect(() => {
    Promise.all([api.people(), api.jobs(), api.phases()])
      .then(([p, j, ph]) => {
        setPeople(p.filter((x) => x.active))
        setJobs(j)
        setPhases(ph)
      })
      .catch((err) => setError(errorText(err)))
  }, [])

  const label = useMemo(() => (j: Job) => (j.kind === 'project' && j.code && !j.name.includes(j.code) ? `${j.code} ${j.name}` : j.name), [])

  const go = async () => {
    setBusy(true)
    setError('')
    try {
      const geo = await grabGeo()
      const r = await api.crew(
        action,
        crew.map((c) => c.id),
        { jobId: action === 'in' ? job?.id : undefined, phaseId: action !== 'out' && phaseId ? phaseId : undefined, geo },
      )
      setResult(r.results.map((x) => (x.ok ? `${x.name}: done` : `${x.name || 'Someone'}: ${x.message}`)))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={() => onClose(Boolean(result))} fullWidth maxWidth="xs">
      <DialogTitle>Crew punch</DialogTitle>
      <DialogContent>
        {result ? (
          <Stack spacing={0.5} sx={{ pt: 1 }}>
            {result.map((line) => (
              <Alert key={line} severity={line.endsWith(': done') ? 'success' : 'warning'} sx={{ py: 0 }}>
                {line}
              </Alert>
            ))}
          </Stack>
        ) : (
          <Stack spacing={2} sx={{ pt: 1 }}>
            <ToggleButtonGroup exclusive fullWidth color="primary" value={action} onChange={(_, v: PunchKind | null) => v && setAction(v)}>
              <ToggleButton value="in">Clock in</ToggleButton>
              <ToggleButton value="next">Next phase</ToggleButton>
              <ToggleButton value="out">Clock out</ToggleButton>
            </ToggleButtonGroup>
            <Autocomplete
              multiple
              options={people}
              value={crew}
              onChange={(_, v) => setCrew(v)}
              getOptionLabel={(p) => p.name}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              renderInput={(params) => <TextField {...params} label="Who" placeholder={crew.length ? '' : 'Pick the crew'} />}
            />
            {action === 'in' && (
              <Autocomplete
                options={jobs}
                value={job}
                onChange={(_, j) => setJob(j)}
                getOptionLabel={label}
                isOptionEqualToValue={(a, b) => a.id === b.id}
                renderInput={(params) => <TextField {...params} label="Job" helperText="Anyone already on the clock switches to this job" />}
              />
            )}
            {action !== 'out' && (
              <TextField select label="Phase" value={phaseId} onChange={(e) => setPhaseId(e.target.value)} helperText={action === 'next' ? 'Leave as Next to move each person on one phase' : undefined}>
                <MenuItem value="">{action === 'next' ? 'Next' : 'First phase of the day'}</MenuItem>
                {phases.map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name}
                  </MenuItem>
                ))}
              </TextField>
            )}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={() => onClose(Boolean(result))}>{result ? 'Done' : 'Cancel'}</Button>
        {!result && (
          <Button variant="contained" disabled={busy || !crew.length || (action === 'in' && !job)} onClick={() => void go()}>
            {action === 'in' ? 'Clock in' : action === 'next' ? 'Next phase' : 'Clock out'} {crew.length || ''}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
