import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
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
import { api, errorText, fmtDay, fmtMoney, type Expense, type ExpenseBody, type ExpenseCategory, type ExpenseStatus, type ExpenseTotals, type Job } from '../api'

// Expenses and mileage. Added from the clock screen onto the current flight (the
// job you are clocked into), or here on their own against any job or none. Each line
// goes to the office for approval when it is added.

const STATUS: Record<ExpenseStatus, { label: string; color: 'default' | 'info' | 'success' | 'error' }> = {
  draft: { label: 'Draft', color: 'default' },
  submitted: { label: 'Waiting', color: 'info' },
  approved: { label: 'Approved', color: 'success' },
  rejected: { label: 'Rejected', color: 'error' },
}
export const StatusChip = ({ status }: { status: ExpenseStatus }) => <Chip size="small" color={STATUS[status].color} label={STATUS[status].label} variant={status === 'submitted' ? 'outlined' : 'filled'} />

const todayYmd = () => new Date().toLocaleDateString('en-CA')
const monthStart = (ymd: string, back = 0) => {
  const d = new Date(`${ymd.slice(0, 7)}-01T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() - back)
  return d.toISOString().slice(0, 10)
}
const jobLabel = (j: { name: string; code: string; kind?: string }) => (j.code && !j.name.includes(j.code) && j.kind !== 'shop' ? `${j.code} ${j.name}` : j.name)

/** A phone photo shrunk to a sensible receipt size (long side 1600 px, JPEG). PDFs pass through. */
async function readReceipt(file: File): Promise<{ type: string; data: string; preview: string | null }> {
  const asDataUrl = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader()
      r.onload = () => resolve(String(r.result))
      r.onerror = () => reject(new Error('Could not read the file.'))
      r.readAsDataURL(blob)
    })
  if (file.type === 'application/pdf') {
    if (file.size > 6 * 1024 * 1024) throw new Error('The PDF is larger than 6 MB.')
    return { type: file.type, data: await asDataUrl(file), preview: null }
  }
  if (!file.type.startsWith('image/')) throw new Error('Pick a photo or a PDF.')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('That photo could not be opened.'))
      i.src = url
    })
    const scale = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(img.naturalWidth * scale)
    canvas.height = Math.round(img.naturalHeight * scale)
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const data = canvas.toDataURL('image/jpeg', 0.8)
    return { type: 'image/jpeg', data, preview: data }
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface FlightInfo {
  jobId: string
  jobName: string
}

/** Add or change one expense. With `flight`, it is charged to the current flight unless changed. */
export function ExpenseDialog({
  open,
  onClose,
  onSaved,
  flight,
  existing,
}: {
  open: boolean
  onClose: () => void
  onSaved: (e: Expense) => void
  flight?: FlightInfo | null
  existing?: Expense | null
}) {
  const [cats, setCats] = useState<ExpenseCategory[]>([])
  const [rate, setRate] = useState(0)
  const [jobs, setJobs] = useState<Job[]>([])
  const [categoryId, setCategoryId] = useState('')
  const [amount, setAmount] = useState('')
  const [miles, setMiles] = useState('')
  const [date, setDate] = useState(todayYmd())
  const [chargeTo, setChargeTo] = useState<'flight' | 'job' | 'none'>('none')
  const [job, setJob] = useState<Job | null>(null)
  const [paidBy, setPaidBy] = useState<'employee' | 'company_card'>('employee')
  const [vendor, setVendor] = useState('')
  const [notes, setNotes] = useState('')
  const [receipt, setReceipt] = useState<{ type: string; data: string; preview: string | null; name: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    setError('')
    setReceipt(null)
    api.expenseCategories().then((r) => {
      setCats(r.data)
      setRate(r.mileageRate)
      if (!existing) setCategoryId((c) => c || r.data[0]?.id || '')
    }, (err) => setError(errorText(err)))
    api.jobs().then((j) => setJobs(j.filter((x) => x.code !== 'OVERHEAD')), () => undefined)
    if (existing) {
      setCategoryId(existing.categoryId)
      setAmount(existing.category.kind === 'mileage' ? '' : String(existing.amount))
      setMiles(existing.miles ? String(existing.miles) : '')
      setDate(existing.date)
      setChargeTo(existing.jobId ? 'job' : 'none')
      setJob(existing.job ? ({ ...existing.job, active: true } as Job) : null)
      setPaidBy(existing.paidBy)
      setVendor(existing.vendor)
      setNotes(existing.notes)
    } else {
      setAmount('')
      setMiles('')
      setDate(todayYmd())
      setChargeTo(flight ? 'flight' : 'none')
      setJob(null)
      setPaidBy('employee')
      setVendor('')
      setNotes('')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, existing, flight?.jobId])

  const cat = cats.find((c) => c.id === categoryId)
  const mileage = cat?.kind === 'mileage'
  const milesN = Number(miles)
  const amountN = Number(amount)
  const valid = Boolean(cat) && (mileage ? milesN > 0 : amountN > 0) && (chargeTo !== 'job' || Boolean(job))

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const body: ExpenseBody = {
        categoryId,
        date,
        paidBy: mileage ? 'employee' : paidBy,
        vendor,
        notes,
        ...(mileage ? { miles: milesN } : { amount: amountN }),
        ...(chargeTo === 'flight' ? { currentFlight: true } : { jobId: chargeTo === 'job' ? job?.id ?? null : null }),
      }
      let saved = existing ? await api.changeExpense(existing.id, body) : await api.addExpense(body)
      if (receipt) {
        try {
          saved = await api.attachReceipt(saved.id, receipt.type, receipt.data)
        } catch (err) {
          // The line is in; only the photo failed. Say so and let them retry from the list.
          onSaved(saved)
          setError(`The expense is saved, but the receipt did not upload: ${errorText(err)} Open it from My expenses to try again.`)
          return
        }
      }
      onSaved(saved)
      onClose()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>{existing ? 'Change expense' : flight ? 'Add expense to this flight' : 'Add expense'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {existing?.status === 'rejected' && existing.decisionNote && <Alert severity="warning">Rejected: {existing.decisionNote}. Fix it and save to send it back.</Alert>}
          <TextField select label="Category" value={cats.some((c) => c.id === categoryId) ? categoryId : ''} onChange={(e) => setCategoryId(e.target.value)}>
            {cats.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
          {mileage ? (
            <TextField
              label="Miles driven"
              type="number"
              inputProps={{ inputMode: 'decimal', min: 0, step: 0.1 }}
              value={miles}
              onChange={(e) => setMiles(e.target.value)}
              helperText={`${fmtMoney(rate)} a mile${milesN > 0 ? ` = ${fmtMoney(Math.round(milesN * rate * 100) / 100)}` : ''}`}
              autoFocus
            />
          ) : (
            <TextField
              label="Amount"
              type="number"
              inputProps={{ inputMode: 'decimal', min: 0, step: 0.01 }}
              InputProps={{ startAdornment: <InputAdornment position="start">$</InputAdornment> }}
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              autoFocus
            />
          )}

          <Box>
            <Typography variant="caption" color="text.secondary">
              Charge to
            </Typography>
            <ToggleButtonGroup exclusive fullWidth size="small" value={chargeTo} onChange={(_, v) => v && setChargeTo(v)} sx={{ mt: 0.5 }}>
              {flight && !existing && <ToggleButton value="flight">Current flight</ToggleButton>}
              <ToggleButton value="job">A job</ToggleButton>
              <ToggleButton value="none">No job</ToggleButton>
            </ToggleButtonGroup>
            {chargeTo === 'flight' && flight && (
              <Typography variant="body2" sx={{ mt: 0.75, fontWeight: 600 }}>
                {flight.jobName}
              </Typography>
            )}
            {chargeTo === 'job' && (
              <Autocomplete
                sx={{ mt: 1 }}
                options={jobs}
                value={job}
                onChange={(_, v) => setJob(v)}
                getOptionLabel={jobLabel}
                isOptionEqualToValue={(a, b) => a.id === b.id}
                groupBy={(j) => ({ project: 'Projects', service: 'Service calls', shop: 'Shop', repair: 'Repair tickets', other: 'Office' })[j.kind] ?? 'Other'}
                renderInput={(params) => <TextField {...params} label="Job" placeholder="Search by name or number" />}
              />
            )}
          </Box>

          {!mileage && (
            <ToggleButtonGroup exclusive fullWidth size="small" value={paidBy} onChange={(_, v) => v && setPaidBy(v)}>
              <ToggleButton value="employee">My money</ToggleButton>
              <ToggleButton value="company_card">Company card</ToggleButton>
            </ToggleButtonGroup>
          )}
          <TextField label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} inputProps={{ max: todayYmd() }} InputLabelProps={{ shrink: true }} />
          {!mileage && <TextField label="Vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="e.g. Platt Electric" inputProps={{ maxLength: 200 }} />}
          <TextField label={mileage ? 'From – to' : 'What it was for'} value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={1} inputProps={{ maxLength: 1000 }} />

          {!mileage && (
            <Box>
              <input
                ref={fileRef}
                type="file"
                accept="image/*,application/pdf"
                capture="environment"
                hidden
                onChange={async (e) => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  if (!f) return
                  try {
                    setReceipt({ ...(await readReceipt(f)), name: f.name })
                  } catch (err) {
                    setError(errorText(err))
                  }
                }}
              />
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Button variant="outlined" onClick={() => fileRef.current?.click()}>
                  {receipt || existing?.hasReceipt ? 'Replace receipt' : 'Add receipt photo'}
                </Button>
                {receipt?.preview && <Box component="img" src={receipt.preview} alt="Receipt" sx={{ height: 56, borderRadius: 1, border: 1, borderColor: 'divider' }} />}
                {receipt && !receipt.preview && <Typography variant="body2">{receipt.name}</Typography>}
                {!receipt && existing?.hasReceipt && (
                  <Typography variant="body2" color="text.secondary">
                    Receipt attached
                  </Typography>
                )}
              </Stack>
            </Box>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={save} disabled={busy || !valid}>
          {busy ? 'Saving…' : existing ? 'Save' : 'Add expense'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Opens the receipt in a new tab (photos and PDFs both). */
export async function openReceipt(id: string, onError: (msg: string) => void) {
  // Open the tab first, while the tap still counts as the person's own action.
  const tab = window.open('', '_blank')
  try {
    const url = await api.receiptUrl(id)
    if (tab) tab.location.href = url
    else window.location.href = url
  } catch (err) {
    tab?.close()
    onError(errorText(err))
  }
}

export function ExpenseLine({ e, showPerson = false, onOpen, actions }: { e: Expense; showPerson?: boolean; onOpen?: () => void; actions?: ReactNode }) {
  const [err, setErr] = useState('')
  return (
    <Box sx={{ py: 1 }}>
      <Stack direction="row" spacing={1} alignItems="flex-start">
        <Box sx={{ flex: 1, minWidth: 0, cursor: onOpen ? 'pointer' : undefined }} onClick={onOpen}>
          <Typography variant="body2" sx={{ fontWeight: 600 }} noWrap>
            {showPerson ? `${e.person.name} · ` : ''}
            {e.category.name}
            {e.vendor ? ` · ${e.vendor}` : ''}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="div">
            {fmtDay(e.date)} · {e.job ? jobLabel(e.job) : 'No job'}
            {showPerson && e.postingAccount ? ` · acct ${e.postingAccount}` : ''}
            {e.miles ? ` · ${e.miles} mi` : ''}
            {e.paidBy === 'company_card' ? ' · company card' : ''}
            {e.notes ? ` · ${e.notes}` : ''}
          </Typography>
          {e.status === 'rejected' && e.decisionNote && (
            <Typography variant="caption" color="error.main" component="div">
              {e.decisionNote}
            </Typography>
          )}
        </Box>
        <Stack alignItems="flex-end" spacing={0.5}>
          <Typography variant="body2" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
            {fmtMoney(e.amount)}
          </Typography>
          <StatusChip status={e.status} />
        </Stack>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5 }}>
        {e.hasReceipt && (
          <Button size="small" onClick={() => void openReceipt(e.id, setErr)} sx={{ px: 0, minWidth: 0 }}>
            Receipt
          </Button>
        )}
        {actions}
      </Stack>
      {err && <Alert severity="error">{err}</Alert>}
    </Box>
  )
}

/** My expenses: this month and last, add one on its own, fix a rejected one. */
export default function ExpensesPage() {
  // On the clock? Then "Current flight" is offered when adding.
  const [flight, setFlight] = useState<FlightInfo | null>(null)
  useEffect(() => {
    api.state().then((s) => setFlight(s.open ? { jobId: s.open.jobId, jobName: s.open.job.name } : null), () => setFlight(null))
  }, [])
  const [rows, setRows] = useState<Expense[] | null>(null)
  const [totals, setTotals] = useState<ExpenseTotals | null>(null)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Expense | null>(null)
  const [back, setBack] = useState(0)
  const from = monthStart(todayYmd(), back)
  const to = back === 0 ? todayYmd() : new Date(new Date(`${monthStart(todayYmd(), back - 1)}T12:00:00Z`).getTime() - 86_400_000).toISOString().slice(0, 10)

  const load = useCallback(async () => {
    try {
      const r = await api.myExpenses(from, to)
      setRows(r.data)
      setTotals(r.totals)
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [from, to])
  useEffect(() => {
    void load()
  }, [load])

  const monthName = useMemo(() => new Date(`${from}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }), [from])

  const remove = async (e: Expense) => {
    if (!window.confirm(`Remove ${e.category.name} ${fmtMoney(e.amount)}?`)) return
    try {
      await api.deleteExpense(e.id)
      await load()
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h6" sx={{ fontWeight: 700, flex: 1 }}>
          My expenses
        </Typography>
        <Button variant="contained" onClick={() => setAdding(true)}>
          Add expense
        </Button>
      </Stack>

      <Stack direction="row" alignItems="center" spacing={1}>
        <Button size="small" onClick={() => setBack(back + 1)}>
          ‹ Earlier
        </Button>
        <Typography sx={{ flex: 1, textAlign: 'center', fontWeight: 600 }}>{monthName}</Typography>
        <Button size="small" disabled={back === 0} onClick={() => setBack(back - 1)}>
          Later ›
        </Button>
      </Stack>

      {totals && totals.count > 0 && (
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
          <Chip label={`${totals.count} line${totals.count === 1 ? '' : 's'} · ${fmtMoney(totals.amount)}`} />
          <Chip variant="outlined" color="primary" label={`Pay me back ${fmtMoney(totals.reimbursable)}`} />
          {totals.waiting > 0 && <Chip variant="outlined" color="info" label={`Waiting ${fmtMoney(totals.waiting)}`} />}
        </Stack>
      )}
      {error && <Alert severity="error">{error}</Alert>}

      <Paper sx={{ px: 2, py: 0.5 }}>
        {rows === null ? (
          <Box sx={{ py: 3, textAlign: 'center' }}>
            <CircularProgress size={24} />
          </Box>
        ) : rows.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 2 }}>
            No expenses in {monthName}. Add one here, or from the clock screen while you are on a flight.
          </Typography>
        ) : (
          <Stack divider={<Divider flexItem />}>
            {rows.map((e) => (
              <ExpenseLine
                key={e.id}
                e={e}
                onOpen={e.status !== 'approved' ? () => setEditing(e) : undefined}
                actions={
                  e.status !== 'approved' && (
                    <>
                      <Button size="small" onClick={() => setEditing(e)} sx={{ px: 0, minWidth: 0 }}>
                        {e.status === 'rejected' ? 'Fix' : 'Change'}
                      </Button>
                      <Button size="small" color="error" onClick={() => void remove(e)} sx={{ px: 0, minWidth: 0 }}>
                        Remove
                      </Button>
                    </>
                  )
                }
              />
            ))}
          </Stack>
        )}
      </Paper>

      <ExpenseDialog open={adding} onClose={() => setAdding(false)} onSaved={() => void load()} flight={flight} />
      <ExpenseDialog open={Boolean(editing)} existing={editing} onClose={() => setEditing(null)} onSaved={() => void load()} />
    </Stack>
  )
}

/** For managers and payroll: expenses waiting for a decision, from any week. */
export function ExpenseApprovals({ canApprove, meId }: { canApprove: boolean; meId?: string }) {
  const [rows, setRows] = useState<Expense[] | null>(null)
  const [rejecting, setRejecting] = useState<Expense | null>(null)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const load = useCallback(() => {
    // Hidden for people who cannot see everyone's expenses.
    api.expenses({ status: 'submitted' }).then((r) => setRows(r.data), () => setRows(null))
  }, [])
  useEffect(() => load(), [load])

  const decide = async (e: Expense, decision: 'approve' | 'reject', why = '') => {
    setBusy(e.id)
    setError('')
    try {
      await api.decideExpense(e.id, decision, why)
      setRejecting(null)
      setNote('')
      load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy('')
    }
  }

  if (!rows || !rows.length) return null
  const total = rows.reduce((s, e) => s + e.amount, 0)
  return (
    <Box>
      <Typography variant="subtitle2" gutterBottom>
        Expenses waiting ({rows.length} · {fmtMoney(total)})
      </Typography>
      {error && <Alert severity="error">{error}</Alert>}
      <Paper sx={{ px: 2, py: 0.5 }}>
        <Stack divider={<Divider flexItem />}>
          {rows.map((e) => (
            <ExpenseLine
              key={e.id}
              e={e}
              showPerson
              actions={
                canApprove &&
                e.personId !== meId && (
                  <>
                    <Box sx={{ flex: 1 }} />
                    <Button size="small" color="error" disabled={busy === e.id} onClick={() => setRejecting(e)}>
                      Reject
                    </Button>
                    <Button size="small" variant="contained" disabled={busy === e.id} onClick={() => void decide(e, 'approve')}>
                      Approve
                    </Button>
                  </>
                )
              }
            />
          ))}
        </Stack>
      </Paper>
      <Dialog open={Boolean(rejecting)} onClose={() => setRejecting(null)} fullWidth maxWidth="xs">
        <DialogTitle>Reject expense</DialogTitle>
        <DialogContent>
          <Typography variant="body2" sx={{ mb: 2 }}>
            {rejecting && `${rejecting.person.name} · ${rejecting.category.name} ${fmtMoney(rejecting.amount)}`}
          </Typography>
          <TextField fullWidth autoFocus label="Why (they will see this)" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Receipt missing" />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRejecting(null)}>Cancel</Button>
          <Button color="error" variant="contained" disabled={!note.trim() || Boolean(busy)} onClick={() => rejecting && void decide(rejecting, 'reject', note)}>
            Reject
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  )
}
