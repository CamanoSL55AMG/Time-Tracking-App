import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  MenuItem,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { api, errorText, fmtDay, type LaborExport, type PayPeriods } from '../api'

// Payroll report: approved hours for a pay period (the 1st to the 15th, or the 16th to
// month end), per person, regular and overtime, by labor type. The same numbers AIC
// Accounting pulls in, so payroll can check one against the other.

const LABOR = ['install', 'programming', 'engineering', 'service', 'management', 'other']
const label = (c: string) => (c ? c[0].toUpperCase() + c.slice(1) : 'Other')
const h2 = (n: number) => n.toFixed(2)
const statusText = (s: string) => (s === 'approved' ? 'On the clock' : s === 'signed' ? 'Signed, not approved' : 'Not signed')

export default function PayrollPage() {
  const [periods, setPeriods] = useState<PayPeriods | null>(null)
  const [pick, setPick] = useState<'previous' | 'current' | 'custom'>('previous')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<LaborExport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(async (a: string, b: string) => {
    setBusy(true)
    setError('')
    try {
      setData(await api.laborExport(a, b))
    } catch (err) {
      setData(null)
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    api
      .payPeriods()
      .then((p) => {
        setPeriods(p)
        setFrom(p.previous.from)
        setTo(p.previous.to)
        if (p.exportEnabled) void run(p.previous.from, p.previous.to)
      })
      .catch((err) => setError(errorText(err)))
  }, [run])

  const choose = (v: 'previous' | 'current' | 'custom') => {
    setPick(v)
    if (v !== 'custom' && periods) {
      setFrom(periods[v].from)
      setTo(periods[v].to)
    }
  }

  const people = useMemo(() => {
    if (!data) return []
    const byPerson = new Map<string, { name: string; email: string; regular: number; overtime: number; cats: Record<string, number>; w2: boolean; c1099: boolean }>()
    for (const l of data.lines) {
      const p = byPerson.get(l.personId) ?? { name: l.personName, email: l.personEmail, regular: 0, overtime: 0, cats: {}, w2: false, c1099: false }
      if (l.workerType === 'contractor') p.c1099 = true
      else p.w2 = true
      p.regular += l.regularHours
      p.overtime += l.overtimeHours
      p.cats[l.laborCategory] = (p.cats[l.laborCategory] ?? 0) + l.hours
      byPerson.set(l.personId, p)
    }
    return [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [data])
  const cats = useMemo(() => {
    const used = new Set(people.flatMap((p) => Object.keys(p.cats)))
    return [...LABOR.filter((c) => used.has(c)), ...[...used].filter((c) => !LABOR.includes(c))]
  }, [people])
  const sum = (f: (p: (typeof people)[number]) => number) => people.reduce((t, p) => t + f(p), 0)

  if (!periods) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
      </Stack>
    )
  }

  const periodLabel = (p: { from: string; to: string }) => `${fmtDay(p.from, { month: 'short', day: 'numeric' })} to ${fmtDay(p.to, { month: 'short', day: 'numeric' })}`

  return (
    <Stack spacing={2}>
      <Typography variant="h6" sx={{ fontWeight: 700 }}>
        Payroll report
      </Typography>
      {!periods.exportEnabled && (
        <Alert severity="info">The payroll export is turned off. Set PAYROLL_EXPORT_ENABLED=true in server/.env and restart Logbook to turn it on.</Alert>
      )}
      <Paper sx={{ p: 2, displayPrint: 'none' }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
          <TextField select size="small" label="Pay period" value={pick} onChange={(e) => choose(e.target.value as typeof pick)} sx={{ minWidth: 220 }}>
            <MenuItem value="previous">{periodLabel(periods.previous)} (last)</MenuItem>
            <MenuItem value="current">{periodLabel(periods.current)} (this one)</MenuItem>
            <MenuItem value="custom">Other dates</MenuItem>
          </TextField>
          <TextField size="small" type="date" label="From" value={from} onChange={(e) => (setPick('custom'), setFrom(e.target.value))} InputLabelProps={{ shrink: true }} />
          <TextField size="small" type="date" label="To" value={to} onChange={(e) => (setPick('custom'), setTo(e.target.value))} InputLabelProps={{ shrink: true }} />
          <Button variant="contained" disabled={busy || !periods.exportEnabled} onClick={() => void run(from, to)}>
            Run
          </Button>
          <Button disabled={!data} onClick={() => void api.downloadLaborCsv(from, to).catch((err) => setError(errorText(err)))}>
            Download CSV
          </Button>
          <Button disabled={!data} onClick={() => window.print()}>
            Print
          </Button>
        </Stack>
        <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
          Only approved weeks are in the report. Overtime is hours over {data?.overtimeWeeklyHours ?? 40} in a Monday to Sunday week, counted in the order worked, so a week
          that crosses the 15th or month end keeps its split in both pay periods.
        </Typography>
      </Paper>

      {error && <Alert severity="error">{error}</Alert>}
      {busy && <CircularProgress sx={{ alignSelf: 'center' }} />}

      {data && (
        <>
          <Typography variant="subtitle1" sx={{ fontWeight: 700 }}>
            {periodLabel(data)}: {h2(sum((p) => p.regular))} regular, {h2(sum((p) => p.overtime))} overtime, {people.length} {people.length === 1 ? 'person' : 'people'}
          </Typography>
          {data.notReady.length > 0 && (
            <Alert severity="warning">
              <Box sx={{ fontWeight: 700, mb: 0.5 }}>Not in this report yet ({data.notReady.length})</Box>
              {data.notReady.map((n) => (
                <div key={`${n.personId}-${n.weekStart}`}>
                  {n.personName}, week of {fmtDay(n.weekStart, { month: 'short', day: 'numeric' })}: {n.approvedThrough ? `approved through ${fmtDay(n.approvedThrough, { month: 'short', day: 'numeric' })}, later days not yet` : statusText(n.status)}, {h2(n.hours)} h
                </div>
              ))}
              <Box sx={{ mt: 0.5 }}>Approve these weeks on Review, then run the report again.</Box>
            </Alert>
          )}
          <TableContainer component={Paper}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Person</TableCell>
                  <TableCell align="right">Regular</TableCell>
                  <TableCell align="right">Overtime</TableCell>
                  <TableCell align="right">Total</TableCell>
                  {cats.map((c) => (
                    <TableCell key={c} align="right">
                      {label(c)}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {people.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={4 + cats.length}>No approved hours in this pay period.</TableCell>
                  </TableRow>
                )}
                {people.map((p) => (
                  <TableRow key={p.email}>
                    <TableCell>
                      {p.name}
                      {p.c1099 && <Chip size="small" color="warning" label={p.w2 ? 'part 1099' : '1099'} sx={{ ml: 1 }} />}
                      <Typography variant="caption" color="text.secondary" component="div">
                        {p.email}
                      </Typography>
                    </TableCell>
                    <TableCell align="right">{h2(p.regular)}</TableCell>
                    <TableCell align="right">{p.overtime ? h2(p.overtime) : ''}</TableCell>
                    <TableCell align="right">{h2(p.regular + p.overtime)}</TableCell>
                    {cats.map((c) => (
                      <TableCell key={c} align="right">
                        {p.cats[c] ? h2(p.cats[c]) : ''}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
                {people.length > 0 && (
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Total</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{h2(sum((p) => p.regular))}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{h2(sum((p) => p.overtime))}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{h2(sum((p) => p.regular + p.overtime))}</TableCell>
                    {cats.map((c) => (
                      <TableCell key={c} align="right" sx={{ fontWeight: 700 }}>
                        {h2(sum((p) => p.cats[c] ?? 0))}
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <Typography variant="caption" color="text.secondary">
            {data.lines.length} lines, one per person, day, job and task. AIC Accounting imports these same lines.
          </Typography>
        </>
      )}
    </Stack>
  )
}
