import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Autocomplete,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  InputAdornment,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { api, errorText, fmtMoney, type Expense, type ExpenseCategory, type Job, type RecurringBody, type RecurringExpense } from '../api'

// Monthly repeats: a bill paid every month (a phone plan, say). Set up once; on its day
// each month a normal expense line is added and sent for approval like any other.
// Pausing skips the months it is paused; stopping is for good.

const thisMonth = () => new Date().toLocaleDateString('en-CA').slice(0, 7)
const ordinal = (n: number) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`
const monthName = (ym: string) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' })
const jobLabel = (j: { name: string; code: string; kind?: string }) => (j.code && !j.name.includes(j.code) && j.kind !== 'shop' ? `${j.code} ${j.name}` : j.name)
const DAYS = Array.from({ length: 31 }, (_, i) => i + 1)

/** Set up or change one monthly repeat. */
export function RecurringDialog({
  open,
  onClose,
  onSaved,
  existing,
}: {
  open: boolean
  onClose: () => void
  onSaved: (r: RecurringExpense, added: Expense[]) => void
  existing?: RecurringExpense | null
}) {
  const [cats, setCats] = useState<ExpenseCategory[]>([])
  const [jobs, setJobs] = useState<Job[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [amount, setAmount] = useState('')
  const [paidBy, setPaidBy] = useState<'employee' | 'company_card'>('employee')
  const [vendor, setVendor] = useState('')
  const [notes, setNotes] = useState('')
  const [chargeTo, setChargeTo] = useState<'job' | 'none'>('none')
  const [job, setJob] = useState<Job | null>(null)
  const [day, setDay] = useState(1)
  const [startMonth, setStartMonth] = useState(thisMonth())
  const [endMonth, setEndMonth] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    setError('')
    api.expenseCategories().then((r) => {
      const amountCats = r.data.filter((c) => c.kind !== 'mileage')
      setCats(amountCats)
      if (!existing) setCategoryId((c) => c || amountCats[0]?.id || '')
    }, (err) => setError(errorText(err)))
    api.jobs().then((j) => setJobs(j.filter((x) => x.code !== 'OVERHEAD')), () => undefined)
    if (existing) {
      setCategoryId(existing.categoryId)
      setAmount(String(existing.amount))
      setPaidBy(existing.paidBy)
      setVendor(existing.vendor)
      setNotes(existing.notes)
      setChargeTo(existing.jobId ? 'job' : 'none')
      setJob(existing.job ? ({ ...existing.job, active: true } as Job) : null)
      setDay(existing.dayOfMonth)
      setStartMonth(existing.startMonth)
      setEndMonth(existing.endMonth ?? '')
    } else {
      setAmount('')
      setPaidBy('employee')
      setVendor('')
      setNotes('')
      setChargeTo('none')
      setJob(null)
      setDay(1)
      setStartMonth(thisMonth())
      setEndMonth('')
    }
  }, [open, existing])

  const amountN = Number(amount)
  const valid = Boolean(categoryId) && amountN > 0 && (chargeTo !== 'job' || Boolean(job)) && (!endMonth || endMonth >= startMonth)

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const body: RecurringBody = {
        categoryId,
        amount: amountN,
        paidBy,
        vendor,
        notes,
        jobId: chargeTo === 'job' ? job?.id ?? null : null,
        dayOfMonth: day,
        endMonth: endMonth || null,
        ...(existing ? {} : { startMonth }),
      }
      const r = existing ? await api.changeRecurring(existing.id, body) : await api.addRecurring(body)
      onSaved(r.recurring, r.added)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const firstLine = startMonth > thisMonth() || day > new Date().getDate() ? `${monthName(startMonth > thisMonth() ? startMonth : thisMonth())}, on the ${ordinal(day)}` : 'today, for this month'

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{existing ? 'Change monthly repeat' : 'Add monthly repeat'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <TextField select label="Category" value={cats.some((c) => c.id === categoryId) ? categoryId : ''} onChange={(e) => setCategoryId(e.target.value)}>
            {cats.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField
            label="Amount each month"
            type="number"
            inputProps={{ inputMode: 'decimal', min: 0, step: 0.01 }}
            InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            autoFocus
          />
          <ToggleButtonGroup exclusive fullWidth size="small" value={paidBy} onChange={(_, v) => v && setPaidBy(v)}>
            <ToggleButton value="employee">My money</ToggleButton>
            <ToggleButton value="company_card">Company card</ToggleButton>
          </ToggleButtonGroup>
          <TextField label="Paid to" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. T-Mobile" inputProps={{ maxLength: 200 }} />
          <TextField label="What it is for" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Work cell phone" inputProps={{ maxLength: 1000 }} />

          <Box>
            <Typography variant="caption" color="text.secondary">
              Charge to
            </Typography>
            <ToggleButtonGroup exclusive fullWidth size="small" value={chargeTo} onChange={(_, v) => v && setChargeTo(v)} sx={{ mt: 0.5 }}>
              <ToggleButton value="job">A job</ToggleButton>
              <ToggleButton value="none">No job</ToggleButton>
            </ToggleButtonGroup>
            {chargeTo === 'job' && (
              <Autocomplete
                sx={{ mt: 1 }}
                options={jobs}
                value={job}
                onChange={(_, v) => setJob(v)}
                getOptionLabel={jobLabel}
                isOptionEqualToValue={(a, b) => a.id === b.id}
                renderInput={(params) => <TextField {...params} label="Job" placeholder="Search by name or number" />}
              />
            )}
          </Box>

          <TextField select label="Day of the month" value={day} onChange={(e) => setDay(Number(e.target.value))} helperText="A shorter month uses its last day.">
            {DAYS.map((d) => (
              <MenuItem key={d} value={d}>
                The {ordinal(d)}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction="row" spacing={1.5}>
            <TextField
              label="First month"
              type="month"
              value={startMonth}
              onChange={(e) => setStartMonth(e.target.value)}
              disabled={Boolean(existing)}
              inputProps={{ min: thisMonth() }}
              InputLabelProps={{ shrink: true }}
              fullWidth
            />
            <TextField
              label="Last month"
              type="month"
              value={endMonth}
              onChange={(e) => setEndMonth(e.target.value)}
              inputProps={{ min: startMonth }}
              InputLabelProps={{ shrink: true }}
              helperText="Empty = until you stop it"
              fullWidth
            />
          </Stack>
          {!existing && (
            <Alert severity="info">
              The first line is added {firstLine}. Each line goes to the office for approval like any expense. No receipt is needed; you can add the bill to any line.
            </Alert>
          )}
          {existing && <Alert severity="info">Changes apply to the months to come. Lines already added stay as they are.</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={save} disabled={busy || !valid}>
          {busy ? 'Saving…' : existing ? 'Save' : 'Start repeat'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Your monthly repeats, with set up, change, pause, resume and stop. */
export function RecurringSection({ onLinesAdded }: { onLinesAdded: () => void }) {
  const [rows, setRows] = useState<RecurringExpense[] | null>(null)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<RecurringExpense | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(() => {
    api.myRecurring().then(setRows, (err) => setError(errorText(err)))
  }, [])
  useEffect(() => load(), [load])

  const saved = (r: RecurringExpense, added: Expense[]) => {
    load()
    if (added.length) {
      setNote(`${r.vendor || r.category.name}: ${added.length === 1 ? `this month's ${fmtMoney(r.amount)} line was added` : `${added.length} lines were added`} and sent for approval.`)
      onLinesAdded()
    } else setNote('')
  }

  const act = async (r: RecurringExpense, action: 'pause' | 'resume' | 'stop') => {
    if (action === 'stop' && !window.confirm(`Stop ${r.vendor || r.category.name} ${fmtMoney(r.amount)} for good? Lines already added stay.`)) return
    setBusy(r.id)
    setError('')
    try {
      const res = await api.setRecurringStatus(r.id, action)
      saved(res.recurring, res.added)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <Typography variant="subtitle2" sx={{ flex: 1 }}>
          Monthly repeats
        </Typography>
        <Button size="small" onClick={() => setAdding(true)}>
          Add monthly repeat
        </Button>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      {note && (
        <Alert severity="success" onClose={() => setNote('')} sx={{ mb: 1 }}>
          {note}
        </Alert>
      )}
      {rows && rows.length > 0 ? (
        <Paper sx={{ px: 2, py: 0.5 }}>
          <Stack divider={<Divider flexItem />}>
            {rows.map((r) => (
              <Box key={r.id} sx={{ py: 1 }}>
                <Stack direction="row" spacing={1} alignItems="flex-start">
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
                      {r.vendor || r.category.name}
                      {r.vendor ? ` · ${r.category.name}` : ''}
                    </Typography>
                    <Typography variant="caption" color="text.secondary" component="div">
                      {r.schedule} · {r.job ? jobLabel(r.job) : 'No job'}
                      {r.paidBy === 'company_card' ? ' · company card' : ''}
                      {r.notes ? ` · ${r.notes}` : ''}
                    </Typography>
                    {r.status === 'paused' && (
                      <Typography variant="caption" color="warning.main" component="div">
                        Paused. Months while paused are skipped.
                      </Typography>
                    )}
                  </Box>
                  <Stack alignItems="flex-end" spacing={0.5}>
                    <Typography variant="body2" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                      {fmtMoney(r.amount)}
                    </Typography>
                    <Chip size="small" label={r.status === 'active' ? 'Monthly' : 'Paused'} color={r.status === 'active' ? 'primary' : 'default'} variant="outlined" />
                  </Stack>
                </Stack>
                <Stack direction="row" spacing={1.5} sx={{ mt: 0.5 }}>
                  <Button size="small" onClick={() => setEditing(r)} disabled={busy === r.id} sx={{ px: 0, minWidth: 0 }}>
                    Change
                  </Button>
                  <Button size="small" onClick={() => void act(r, r.status === 'active' ? 'pause' : 'resume')} disabled={busy === r.id} sx={{ px: 0, minWidth: 0 }}>
                    {r.status === 'active' ? 'Pause' : 'Resume'}
                  </Button>
                  <Button size="small" color="error" onClick={() => void act(r, 'stop')} disabled={busy === r.id} sx={{ px: 0, minWidth: 0 }}>
                    Stop
                  </Button>
                </Stack>
              </Box>
            ))}
          </Stack>
        </Paper>
      ) : (
        rows && (
          <Typography variant="body2" color="text.secondary">
            A bill you pay every month, like a phone plan, can be added once and sent in each month by itself.
          </Typography>
        )
      )}
      <RecurringDialog open={adding} onClose={() => setAdding(false)} onSaved={saved} />
      <RecurringDialog open={Boolean(editing)} existing={editing} onClose={() => setEditing(null)} onSaved={saved} />
    </Box>
  )
}
