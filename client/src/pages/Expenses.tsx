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
  Divider,
  MenuItem,
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import {
  api,
  errorText,
  fmtDay,
  fmtMoney,
  money,
  todayYmd,
  type Expense,
  type ExpenseCategory,
  type ExpenseInput,
  type ExpenseReport,
  type Job,
  type MileageRate,
  type Person,
} from '../api'

// Expenses and mileage. A tech adds lines as they go (a photo of the receipt
// with each), then submits them together. A manager sees submitted reports and
// approves them or sends them back with a note.

const STATUS_LABEL: Record<string, string> = {
  draft: 'Not submitted',
  rejected: 'Sent back',
  submitted: 'Waiting for approval',
  approved: 'Approved',
  exported: 'Paid / posted',
}
const STATUS_COLOR: Record<string, 'default' | 'warning' | 'info' | 'success'> = {
  draft: 'default',
  rejected: 'warning',
  submitted: 'info',
  approved: 'success',
  exported: 'success',
}

const jobLabel = (j: { name: string; code: string } | null) => (j ? (j.code && !j.name.includes(j.code) ? `${j.code} ${j.name}` : j.name) : 'No job')

/** Phone photos are large; send a 1600 px JPEG instead. PDFs and small files go as they are. */
async function shrink(file: File): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type) || file.size < 1_500_000) return file
  try {
    const bmp = await createImageBitmap(file)
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bmp.width * scale)
    canvas.height = Math.round(bmp.height * scale)
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', 0.82))
    return blob ?? file
  } catch {
    return file
  }
}

export default function ExpensesPage({ me }: { me: Person }) {
  const canApprove = me.scopes.includes('expenses:approve')
  const [lines, setLines] = useState<Expense[] | null>(null)
  const [reports, setReports] = useState<ExpenseReport[]>([])
  const [cats, setCats] = useState<ExpenseCategory[]>([])
  const [rate, setRate] = useState<MileageRate | null>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Expense | 'new' | null>(null)
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<{ url: string; type: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const [l, r, c, rt, j] = await Promise.all([
        money.expenses({ personId: me.id }),
        money.reports(),
        money.categories(),
        money.rates(),
        api.jobs(),
      ])
      setLines(l.filter((x) => x.personId === me.id))
      setReports(r)
      setCats(c)
      setRate(rt.current)
      setJobs(j)
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [me.id])

  useEffect(() => {
    void load()
  }, [load])

  const mine = lines ?? []
  const unsent = mine.filter((l) => l.status === 'draft' && !l.reportId)
  const sentBack = reports.filter((r) => r.personId === me.id && r.status === 'rejected')
  const waiting = mine.filter((l) => l.status === 'submitted')
  const done = mine.filter((l) => l.status === 'approved' || l.status === 'exported').slice(0, 20)
  const toApprove = canApprove ? reports.filter((r) => r.status === 'submitted' && r.personId !== me.id) : []
  const unsentTotal = unsent.reduce((t, l) => t + l.amountCents, 0)

  const submit = async () => {
    setBusy(true)
    try {
      await money.submitDrafts(`Week of ${fmtDay(unsent[unsent.length - 1]?.date ?? todayYmd())}`)
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const resubmit = async (r: ExpenseReport) => {
    setBusy(true)
    try {
      await money.resubmit(r.id)
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const showReceipt = async (l: Expense) => {
    try {
      setReceipt({ url: await money.receiptUrl(l.id), type: l.receipt?.mimeType ?? '' })
    } catch (err) {
      setError(errorText(err))
    }
  }
  const closeReceipt = () => {
    if (receipt) URL.revokeObjectURL(receipt.url)
    setReceipt(null)
  }

  if (!lines) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }} spacing={2}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
        {error && <Button onClick={() => void load()}>Try again</Button>}
      </Stack>
    )
  }

  return (
    <Stack spacing={2.5}>
      {error && (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {toApprove.length > 0 && (
        <Stack spacing={1.25}>
          <Typography variant="overline" color="text.secondary">
            Waiting for your approval
          </Typography>
          {toApprove.map((r) => (
            <ApprovalCard key={r.id} report={r} onReceipt={showReceipt} onDone={load} onError={setError} />
          ))}
          <Divider />
        </Stack>
      )}

      <Paper sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="baseline" spacing={1}>
            <Typography variant="h6" sx={{ fontWeight: 700, flex: 1 }}>
              Not submitted yet
            </Typography>
            <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(unsentTotal)}</Typography>
          </Stack>
          {unsent.length === 0 && <Typography color="text.secondary">Add fuel, parts, meals or miles as you go, then submit them together.</Typography>}
          {unsent.map((l) => (
            <LineRow key={l.id} line={l} onOpen={() => setEditing(l)} onReceipt={() => void showReceipt(l)} />
          ))}
          <Stack direction="row" spacing={1}>
            <Button variant="contained" size="large" sx={{ flex: 1 }} onClick={() => setEditing('new')}>
              Add expense
            </Button>
            {unsent.length > 0 && (
              <Button variant="contained" color="secondary" size="large" sx={{ flex: 1 }} disabled={busy} onClick={() => void submit()}>
                Submit {unsent.length}
              </Button>
            )}
          </Stack>
        </Stack>
      </Paper>

      {sentBack.map((r) => (
        <Paper key={r.id} sx={{ p: 2, borderColor: 'warning.main' }}>
          <Stack spacing={1.25}>
            <Alert severity="warning">
              Sent back{r.decidedBy ? ` by ${r.decidedBy.name}` : ''}: {r.decisionNote || 'see the lines below'}
            </Alert>
            {r.lines.map((l) => (
              <LineRow key={l.id} line={l} onOpen={() => setEditing(l)} onReceipt={() => void showReceipt(l)} />
            ))}
            <Button variant="contained" disabled={busy} onClick={() => void resubmit(r)}>
              Submit again
            </Button>
          </Stack>
        </Paper>
      ))}

      {waiting.length > 0 && (
        <Section title="Waiting for approval">
          {waiting.map((l) => (
            <LineRow key={l.id} line={l} onReceipt={() => void showReceipt(l)} />
          ))}
        </Section>
      )}
      {done.length > 0 && (
        <Section title="Approved">
          {done.map((l) => (
            <LineRow key={l.id} line={l} onReceipt={() => void showReceipt(l)} />
          ))}
        </Section>
      )}

      {editing && (
        <LineDialog
          line={editing === 'new' ? null : editing}
          cats={cats}
          jobs={jobs}
          rate={rate}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null)
            await load()
          }}
        />
      )}

      <Dialog open={Boolean(receipt)} onClose={closeReceipt} fullWidth maxWidth="sm">
        <DialogContent sx={{ p: 1 }}>
          {receipt?.type === 'application/pdf' ? (
            <Stack spacing={1} sx={{ p: 2 }}>
              <Typography>This receipt is a PDF.</Typography>
              <Button href={receipt.url} target="_blank" rel="noreferrer" variant="outlined">
                Open the PDF
              </Button>
            </Stack>
          ) : (
            receipt && <Box component="img" src={receipt.url} alt="Receipt" sx={{ width: '100%', display: 'block', borderRadius: 1 }} />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={closeReceipt}>Close</Button>
        </DialogActions>
      </Dialog>
    </Stack>
  )
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <Stack spacing={1}>
    <Typography variant="overline" color="text.secondary">
      {title}
    </Typography>
    {children}
  </Stack>
)

function LineRow({ line, onOpen, onReceipt }: { line: Expense; onOpen?: () => void; onReceipt: () => void }) {
  const detail = line.category.mileage
    ? `${line.miles} mi at ${((line.rateMills ?? 0) / 10).toFixed(1)}¢`
    : [line.vendor, line.paidBy === 'company' ? 'company card' : ''].filter(Boolean).join(' · ')
  const needsReceipt = !line.receipt && !line.category.mileage
  return (
    <Paper
      variant="outlined"
      sx={{ p: 1.5, cursor: onOpen ? 'pointer' : 'default' }}
      onClick={onOpen}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onKeyDown={(e) => {
        if (onOpen && (e.key === 'Enter' || e.key === ' ')) onOpen()
      }}
    >
      <Stack direction="row" spacing={1.5} alignItems="flex-start">
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 600 }}>{line.category.name}</Typography>
          <Typography variant="body2" color="text.secondary">
            {fmtDay(line.date)} · {jobLabel(line.job)}
          </Typography>
          {detail && (
            <Typography variant="body2" color="text.secondary">
              {detail}
            </Typography>
          )}
          {line.receipt ? (
            <Button
              size="small"
              sx={{ ml: -0.75, mt: 0.25 }}
              onClick={(e) => {
                e.stopPropagation()
                onReceipt()
              }}
            >
              View receipt
            </Button>
          ) : (
            needsReceipt && (
              <Typography variant="caption" color="warning.main">
                No receipt yet{onOpen ? ': tap to add one' : ''}
              </Typography>
            )
          )}
        </Box>
        <Stack alignItems="flex-end" spacing={0.5}>
          <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(line.amountCents)}</Typography>
          {line.status !== 'draft' && <Chip size="small" color={STATUS_COLOR[line.status]} label={STATUS_LABEL[line.status]} />}
        </Stack>
      </Stack>
    </Paper>
  )
}

function LineDialog({
  line,
  cats,
  jobs,
  rate,
  onClose,
  onSaved,
}: {
  line: Expense | null
  cats: ExpenseCategory[]
  jobs: Job[]
  rate: MileageRate | null
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const [form, setForm] = useState<ExpenseInput & { milesText: string }>(() => ({
    date: line?.date ?? todayYmd(),
    categoryId: line?.category.id ?? cats[0]?.id ?? '',
    jobId: line?.job?.id ?? null,
    amount: line && !line.category.mileage ? (line.amountCents / 100).toFixed(2) : '',
    milesText: line?.miles ? String(line.miles) : '',
    paidBy: line?.paidBy ?? 'employee',
    vendor: line?.vendor ?? '',
    notes: line?.notes ?? '',
  }))
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const cat = cats.find((c) => c.id === form.categoryId) ?? (line ? { ...line.category, sortOrder: 0, active: true } : undefined)
  const miles = Number(form.milesText)
  const mileAmount = cat?.mileage && rate && miles > 0 ? Math.round((miles * rate.rateMills) / 10) : null
  const job = useMemo(() => jobs.find((j) => j.id === form.jobId) ?? null, [jobs, form.jobId])
  const editable = !line || line.editable

  const save = async () => {
    setBusy(true)
    setError('')
    try {
      const body: ExpenseInput = {
        date: form.date,
        categoryId: form.categoryId,
        jobId: form.jobId,
        paidBy: form.paidBy,
        vendor: form.vendor,
        notes: form.notes,
        ...(cat?.mileage ? { miles } : { amount: form.amount }),
      }
      const saved = line ? await money.saveExpense(line.id, body) : await money.addExpense(body)
      if (file) {
        try {
          await money.uploadReceipt(saved.id, await shrink(file))
        } catch (err) {
          setError(`The expense is saved, but the receipt did not upload: ${errorText(err)} Open the line and attach it again.`)
          setBusy(false)
          return
        }
      }
      await onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!line) return
    setBusy(true)
    try {
      await money.deleteExpense(line.id)
      await onSaved()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  const valid = form.date && form.categoryId && (cat?.mileage ? miles > 0 : /^\d+(\.\d{1,2})?$/.test(String(form.amount).replace(/[$,]/g, '')))

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{line ? 'Expense' : 'Add expense'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {!editable && <Alert severity="info">This line is {STATUS_LABEL[line!.status].toLowerCase()} and can no longer be changed.</Alert>}
          <TextField select label="What for" value={form.categoryId} disabled={!editable} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
            {cats.map((c) => (
              <MenuItem key={c.id} value={c.id}>
                {c.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Date" type="date" value={form.date} disabled={!editable} onChange={(e) => setForm({ ...form, date: e.target.value })} InputLabelProps={{ shrink: true }} />
          {cat?.mileage ? (
            <TextField
              label="Miles"
              inputMode="decimal"
              value={form.milesText}
              disabled={!editable}
              onChange={(e) => setForm({ ...form, milesText: e.target.value })}
              helperText={
                rate
                  ? mileAmount !== null
                    ? `${fmtMoney(mileAmount)} at ${rate.centsPerMile}¢ a mile`
                    : `Paid at ${rate.centsPerMile}¢ a mile`
                  : 'No mileage rate is set up yet. Ask the office.'
              }
            />
          ) : (
            <TextField
              label="Amount"
              inputMode="decimal"
              value={form.amount}
              disabled={!editable}
              onChange={(e) => setForm({ ...form, amount: e.target.value })}
              InputProps={{ startAdornment: <Typography sx={{ mr: 0.5 }}>$</Typography> }}
            />
          )}
          <Autocomplete
            options={jobs}
            value={job}
            disabled={!editable}
            getOptionLabel={jobLabel}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            onChange={(_, v) => setForm({ ...form, jobId: v?.id ?? null })}
            renderInput={(p) => <TextField {...p} label="Job" helperText="Which job this goes against" />}
          />
          {!cat?.mileage && (
            <>
              <ToggleButtonGroup exclusive fullWidth value={form.paidBy} disabled={!editable} onChange={(_, v) => v && setForm({ ...form, paidBy: v })}>
                <ToggleButton value="employee">I paid (pay me back)</ToggleButton>
                <ToggleButton value="company">Company card</ToggleButton>
              </ToggleButtonGroup>
              <TextField label="Store or vendor" value={form.vendor} disabled={!editable} onChange={(e) => setForm({ ...form, vendor: e.target.value })} />
            </>
          )}
          <TextField label="Note" multiline minRows={2} value={form.notes} disabled={!editable} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          {editable && !cat?.mileage && (
            <Button component="label" variant="outlined">
              {file ? `Receipt: ${file.name}` : line?.receipt ? 'Replace the receipt photo' : 'Take or add a receipt photo'}
              <input hidden type="file" accept="image/*,application/pdf" capture="environment" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </Button>
          )}
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        {line && editable && (
          <Button color="warning" onClick={() => void remove()} disabled={busy} sx={{ mr: 'auto' }}>
            Delete
          </Button>
        )}
        <Button onClick={onClose}>{editable ? 'Cancel' : 'Close'}</Button>
        {editable && (
          <Button variant="contained" onClick={() => void save()} disabled={busy || !valid}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

function ApprovalCard({
  report,
  onReceipt,
  onDone,
  onError,
}: {
  report: ExpenseReport
  onReceipt: (l: Expense) => Promise<void>
  onDone: () => Promise<void>
  onError: (m: string) => void
}) {
  const [note, setNote] = useState('')
  const [sendingBack, setSendingBack] = useState(false)
  const [busy, setBusy] = useState(false)
  const decide = async (action: 'approve' | 'reject') => {
    setBusy(true)
    try {
      await money.decide(report.id, action, note.trim())
      await onDone()
    } catch (err) {
      onError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1.25}>
        <Stack direction="row" alignItems="baseline" spacing={1}>
          <Typography sx={{ fontWeight: 700, flex: 1 }}>{report.person?.name ?? 'Someone'}</Typography>
          <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtMoney(report.totalCents)}</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {report.title || 'Expenses'} · {report.lines.length} line{report.lines.length === 1 ? '' : 's'}
          {report.companyCardCents > 0 && ` · ${fmtMoney(report.companyCardCents)} on the company card`}
          {report.missingReceipts > 0 && ` · ${report.missingReceipts} without a receipt`}
        </Typography>
        {report.lines.map((l) => (
          <LineRow key={l.id} line={l} onReceipt={() => void onReceipt(l)} />
        ))}
        {sendingBack ? (
          <Stack spacing={1}>
            <TextField label="What needs fixing" value={note} onChange={(e) => setNote(e.target.value)} autoFocus multiline />
            <Stack direction="row" spacing={1}>
              <Button onClick={() => setSendingBack(false)}>Cancel</Button>
              <Button variant="contained" color="warning" disabled={busy || !note.trim()} onClick={() => void decide('reject')}>
                Send back
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" color="warning" sx={{ flex: 1 }} onClick={() => setSendingBack(true)}>
              Send back
            </Button>
            <Button variant="contained" color="success" sx={{ flex: 1 }} disabled={busy} onClick={() => void decide('approve')}>
              Approve
            </Button>
          </Stack>
        )}
      </Stack>
    </Paper>
  )
}
