import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  MenuItem,
  Paper,
  Stack,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  Typography,
} from '@mui/material'
import { api, errorText, fmtDay, fmtH, leave, todayYmd, type LeavePolicy, type LeaveType, type OpeningResult, type Person, type PersonLeave, type Statements } from '../api'

// Leave setup for the office: start dates, who is on which vacation rule,
// opening balances from the spreadsheet, corrections and monthly statements.
// Washington sick leave applies to everyone on its own.

const METHOD_LABEL: Record<LeavePolicy['method'], string> = {
  per_hours_worked: 'Per hours worked',
  per_month: 'Each month',
  annual_grant: 'Once a year',
}

const describe = (p: LeavePolicy) => {
  const rate =
    p.method === 'per_hours_worked'
      ? `${p.rateHours} h per ${p.perHours} h worked`
      : p.method === 'per_month'
        ? `${p.rateHours} h a month`
        : `${p.rateHours} h a year on ${p.grantOn === 'anniversary' ? 'the work anniversary' : '1 January'}`
  return [
    rate,
    p.capHours !== null ? `cap ${p.capHours} h` : '',
    p.carryoverMax !== null ? `carry over up to ${p.carryoverMax} h` : 'no carryover limit',
    p.waitingDays ? `usable after ${p.waitingDays} days` : '',
    p.tiers.length ? p.tiers.map((t) => `${t.rateHours} h after ${t.afterYears} yrs`).join(', ') : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export default function ManageLeave() {
  const [people, setPeople] = useState<Person[]>([])
  const [types, setTypes] = useState<LeaveType[]>([])
  const [policies, setPolicies] = useState<LeavePolicy[]>([])
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [addingPolicy, setAddingPolicy] = useState(false)
  const [importing, setImporting] = useState(false)
  const [open, setOpen] = useState<Person | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [p, t, pol] = await Promise.all([api.people(), leave.types(true), leave.policies()])
      setPeople(p.filter((x) => x.active))
      setTypes(t)
      setPolicies(pol)
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])

  const runAccruals = async () => {
    setBusy(true)
    try {
      const r = await leave.runAccruals()
      setNotice(r.entries ? `Added ${fmtH(r.hours)} across ${r.people} people, for weeks through ${fmtDay(r.through)}.` : `Everyone is up to date through ${fmtDay(r.through)}.`)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const typeName = (id: string) => types.find((t) => t.id === id)?.name ?? ''

  return (
    <Stack spacing={2}>
      {error && (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert severity="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}

      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <Button variant="contained" onClick={() => setImporting(true)}>
          Import opening balances
        </Button>
        <Button variant="outlined" disabled={busy} onClick={() => void runAccruals()}>
          Update accruals now
        </Button>
      </Stack>
      <Typography variant="body2" color="text.secondary">
        Accruals update every night from punched hours, a week after each week ends so corrections are in first.
      </Typography>

      <Typography variant="overline" color="text.secondary">
        Rules
      </Typography>
      {policies.map((p) => (
        <Paper key={p.id} sx={{ p: 1.5, opacity: p.active ? 1 : 0.55 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }}>
                {p.name}{' '}
                <Typography component="span" color="text.secondary">
                  · {typeName(p.leaveTypeId)}
                </Typography>
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {describe(p)}
              </Typography>
            </Box>
            <Chip size="small" label={p.appliesToAll ? 'Everyone' : `${p.assignedPeople ?? 0} people`} />
          </Stack>
        </Paper>
      ))}
      <Box>
        <Button onClick={() => setAddingPolicy(true)}>Add a vacation rule</Button>
      </Box>

      <Typography variant="overline" color="text.secondary">
        People
      </Typography>
      {people.map((p) => (
        <Paper key={p.id} sx={{ p: 1.5, cursor: 'pointer' }} onClick={() => setOpen(p)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setOpen(p)}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography sx={{ fontWeight: 600 }} noWrap>
                {p.name}
              </Typography>
              <Typography variant="body2" color={p.hireDate ? 'text.secondary' : 'warning.main'} noWrap>
                {p.hireDate ? `Started ${fmtDay(p.hireDate)}` : 'Start date missing: needed for sick leave'}
              </Typography>
            </Box>
            <Button size="small">Open</Button>
          </Stack>
        </Paper>
      ))}

      <StatementsPanel />

      {addingPolicy && (
        <PolicyDialog
          types={types.filter((t) => t.drawsBalance && t.statutory !== 'wa_sick')}
          onClose={() => setAddingPolicy(false)}
          onSaved={async () => {
            setAddingPolicy(false)
            await load()
          }}
        />
      )}
      {importing && <ImportDialog people={people} types={types} onClose={() => setImporting(false)} />}
      {open && (
        <PersonDialog
          person={open}
          types={types}
          policies={policies}
          onClose={async () => {
            setOpen(null)
            await load()
          }}
        />
      )}
    </Stack>
  )
}

// ─── A vacation rule ────────────────────────────────────────────────────────

function PolicyDialog({ types, onClose, onSaved }: { types: LeaveType[]; onClose: () => void; onSaved: () => Promise<void> }) {
  const [f, setF] = useState({
    leaveTypeId: types.find((t) => t.key === 'vacation')?.id ?? types[0]?.id ?? '',
    name: 'Vacation',
    method: 'annual_grant' as LeavePolicy['method'],
    rateHours: '80',
    perHours: '40',
    grantOn: 'anniversary' as LeavePolicy['grantOn'],
    capHours: '',
    carryoverMax: '',
    waitingDays: '0',
  })
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const n = (s: string) => (s.trim() === '' ? null : Number(s))
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await leave.addPolicy({
        leaveTypeId: f.leaveTypeId,
        name: f.name.trim(),
        method: f.method,
        rateHours: Number(f.rateHours),
        perHours: Number(f.perHours) || 40,
        grantOn: f.grantOn,
        capHours: n(f.capHours),
        carryoverMax: n(f.carryoverMax),
        waitingDays: Number(f.waitingDays) || 0,
      })
      await onSaved()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }
  const unit = f.method === 'per_hours_worked' ? `hours per ${f.perHours || 40} hours worked` : f.method === 'per_month' ? 'hours each month' : 'hours each year'
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Add a vacation rule</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField label="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} helperText='e.g. "Vacation, 1–4 years"' />
          {types.length > 1 && (
            <TextField select label="Kind of leave" value={f.leaveTypeId} onChange={(e) => setF({ ...f, leaveTypeId: e.target.value })}>
              {types.map((t) => (
                <MenuItem key={t.id} value={t.id}>
                  {t.name}
                </MenuItem>
              ))}
            </TextField>
          )}
          <TextField select label="How it is earned" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value as LeavePolicy['method'] })}>
            {Object.entries(METHOD_LABEL).map(([k, v]) => (
              <MenuItem key={k} value={k}>
                {v}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction="row" spacing={1}>
            <TextField label="Hours" inputMode="decimal" value={f.rateHours} onChange={(e) => setF({ ...f, rateHours: e.target.value })} helperText={unit} sx={{ flex: 1 }} />
            {f.method === 'per_hours_worked' && (
              <TextField label="Per hours worked" inputMode="decimal" value={f.perHours} onChange={(e) => setF({ ...f, perHours: e.target.value })} sx={{ flex: 1 }} />
            )}
          </Stack>
          {f.method === 'annual_grant' && (
            <TextField select label="Given on" value={f.grantOn} onChange={(e) => setF({ ...f, grantOn: e.target.value as LeavePolicy['grantOn'] })}>
              <MenuItem value="anniversary">Each work anniversary</MenuItem>
              <MenuItem value="calendar">1 January</MenuItem>
            </TextField>
          )}
          <TextField label="Most a person can hold (hours)" inputMode="decimal" value={f.capHours} onChange={(e) => setF({ ...f, capHours: e.target.value })} helperText="Leave blank for no cap" />
          <TextField label="Most that carries into the next year (hours)" inputMode="decimal" value={f.carryoverMax} onChange={(e) => setF({ ...f, carryoverMax: e.target.value })} helperText="Leave blank to carry everything over" />
          <TextField label="Usable after (days from start)" inputMode="numeric" value={f.waitingDays} onChange={(e) => setF({ ...f, waitingDays: e.target.value })} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !f.name.trim() || !(Number(f.rateHours) > 0)} onClick={() => void save()}>
          Add rule
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── One person ─────────────────────────────────────────────────────────────

function PersonDialog({ person, types, policies, onClose }: { person: Person; types: LeaveType[]; policies: LeavePolicy[]; onClose: () => Promise<void> }) {
  const [data, setData] = useState<PersonLeave | null>(null)
  const [hire, setHire] = useState(person.hireDate ?? '')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [adj, setAdj] = useState({ leaveTypeId: '', hours: '', reason: '' })

  const load = useCallback(async () => {
    try {
      setData(await leave.person(person.id))
    } catch (err) {
      setError(errorText(err))
    }
  }, [person.id])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true)
    setError('')
    try {
      await fn()
      setNotice(done)
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const individual = policies.filter((p) => p.active && !p.appliesToAll)
  /** Put the person on a rule from today (or from their start date if they had none), ending the one before. */
  const assign = (policyId: string) =>
    run(async () => {
      const policy = policies.find((p) => p.id === policyId)
      if (!data || !policy) return
      const today = todayYmd()
      const y = new Date(Date.now() - 86_400_000)
      const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`
      const hadOne = data.assignments.some((a) => a.leaveTypeId === policy.leaveTypeId)
      const kept = data.assignments.flatMap((a) => {
        const row = { leavePolicyId: a.leavePolicyId, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo }
        if (a.leaveTypeId !== policy.leaveTypeId || a.effectiveTo) return [row]
        // The rule in force ends yesterday; one that only started today is replaced outright.
        return a.effectiveFrom <= yesterday ? [{ ...row, effectiveTo: yesterday }] : []
      })
      // A first rule counts from the start date, so earlier service is not lost.
      const from = hadOne ? today : hire || today
      await leave.setAssignments(person.id, [...kept, { leavePolicyId: policy.id, effectiveFrom: from }])
    }, 'Rule saved.')

  const current = (typeId: string) => data?.assignments.find((a) => a.leaveTypeId === typeId && !a.effectiveTo)
  const vacationTypes = types.filter((t) => t.drawsBalance && t.statutory !== 'wa_sick')

  return (
    <Dialog open onClose={() => void onClose()} fullWidth maxWidth="sm">
      <DialogTitle>{person.name}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          {notice && <Alert severity="success">{notice}</Alert>}
          <Stack direction="row" spacing={1} alignItems="flex-start">
            <TextField label="First day of work" type="date" value={hire} onChange={(e) => setHire(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ flex: 1 }} helperText="Sick leave is usable from day 90" />
            <Button variant="outlined" disabled={busy || hire === (person.hireDate ?? '')} sx={{ mt: 1 }} onClick={() => void run(() => leave.setHireDate(person.id, hire || null), 'Start date saved.')}>
              Save
            </Button>
          </Stack>

          {vacationTypes.map((t) => (
            <TextField key={t.id} select label={`${t.name} rule`} value={current(t.id)?.leavePolicyId ?? ''} disabled={busy} onChange={(e) => void assign(e.target.value)}>
              {individual
                .filter((p) => p.leaveTypeId === t.id)
                .map((p) => (
                  <MenuItem key={p.id} value={p.id}>
                    {p.name} · {describe(p)}
                  </MenuItem>
                ))}
              {individual.filter((p) => p.leaveTypeId === t.id).length === 0 && (
                <MenuItem disabled value="">
                  Add a vacation rule first
                </MenuItem>
              )}
            </TextField>
          ))}

          <Stack spacing={0.75}>
            {(data?.types ?? [])
              .filter((b) => b.leaveType.drawsBalance)
              .map((b) => (
                <Paper key={b.leaveType.id} variant="outlined" sx={{ p: 1.25 }}>
                  <Stack direction="row" alignItems="baseline" spacing={1}>
                    <Typography sx={{ fontWeight: 600, flex: 1 }}>{b.leaveType.name}</Typography>
                    <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{fmtH(b.balance)}</Typography>
                  </Stack>
                  <Typography variant="body2" color="text.secondary">
                    {fmtH(b.pending)} waiting · {fmtH(b.earnedThisYear)} earned and {fmtH(b.usedThisYear)} used this year
                    {b.usableNow === false && b.usableFrom ? ` · usable from ${fmtDay(b.usableFrom)}` : ''}
                  </Typography>
                </Paper>
              ))}
          </Stack>

          <Typography variant="subtitle2">Correct a balance</Typography>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label="Kind" value={adj.leaveTypeId} onChange={(e) => setAdj({ ...adj, leaveTypeId: e.target.value })} sx={{ minWidth: 140 }}>
              {types
                .filter((t) => t.drawsBalance)
                .map((t) => (
                  <MenuItem key={t.id} value={t.id}>
                    {t.name}
                  </MenuItem>
                ))}
            </TextField>
            <TextField size="small" label="Hours (+/−)" inputMode="decimal" value={adj.hours} onChange={(e) => setAdj({ ...adj, hours: e.target.value })} sx={{ width: 120 }} />
            <TextField size="small" label="Reason" value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} sx={{ flex: 1, minWidth: 160 }} />
            <Button
              variant="outlined"
              disabled={busy || !adj.leaveTypeId || !Number(adj.hours) || !adj.reason.trim()}
              onClick={() =>
                void run(async () => {
                  await leave.adjust({ personId: person.id, leaveTypeId: adj.leaveTypeId, hours: Number(adj.hours), date: todayYmd(), reason: adj.reason.trim() })
                  setAdj({ leaveTypeId: '', hours: '', reason: '' })
                }, 'Balance corrected.')
              }
            >
              Save
            </Button>
          </Stack>
          <LedgerList personId={person.id} key={notice} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={() => void onClose()}>Close</Button>
      </DialogActions>
    </Dialog>
  )
}

function LedgerList({ personId }: { personId: string }) {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof leave.ledger>> | null>(null)
  useEffect(() => {
    leave.ledger(personId).then(setRows).catch(() => setRows([]))
  }, [personId])
  if (!rows?.length) return null
  return (
    <Stack spacing={0.5}>
      <Typography variant="subtitle2">Every change, newest first</Typography>
      {[...rows].reverse().slice(0, 60).map((r) => (
        <Stack key={r.id} direction="row" spacing={1} sx={{ py: 0.75, borderTop: '1px solid', borderColor: 'divider' }}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {fmtDay(r.date)} · {r.leaveType.name}
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {r.note || r.kind}
            </Typography>
          </Box>
          <Stack alignItems="flex-end" sx={{ fontVariantNumeric: 'tabular-nums' }}>
            <Typography variant="body2" sx={{ fontWeight: 700, color: r.hours < 0 ? 'warning.main' : 'success.main' }}>
              {r.hours > 0 ? '+' : ''}
              {fmtH(r.hours)}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              = {fmtH(r.balanceAfter)}
            </Typography>
          </Stack>
        </Stack>
      ))}
    </Stack>
  )
}

// ─── Opening balances ───────────────────────────────────────────────────────

/** A small CSV reader: quoted fields, commas inside quotes, CRLF. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"'
        i += 1
      } else if (c === '"') quoted = false
      else cell += c
    } else if (c === '"') quoted = true
    else if (c === ',') {
      row.push(cell.trim())
      cell = ''
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell.trim())
      if (row.some(Boolean)) rows.push(row)
      row = []
      cell = ''
    } else cell += c
  }
  row.push(cell.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

/**
 * Turns the sheet into { email, leaveType, hours } rows. Works with one row per
 * person and a column per kind of leave ("Name, Sick, Vacation"), or one row per
 * balance ("Email, Type, Hours"). People are matched by email, or by exact name.
 */
function sheetRows(grid: string[][], people: Person[], types: LeaveType[]) {
  if (grid.length < 2) return { rows: [], note: 'The file needs a header row and at least one row of balances.' }
  const head = grid[0].map((h) => h.toLowerCase())
  const emailCol = head.findIndex((h) => h.includes('email'))
  const nameCol = head.findIndex((h) => h === 'name' || h.includes('employee') || h === 'person')
  const typeCol = head.findIndex((h) => h === 'type' || h.includes('leave type') || h === 'kind')
  const hoursCol = head.findIndex((h) => h.includes('hours') || h === 'balance')
  const who = (r: string[]) => {
    if (emailCol >= 0 && r[emailCol]) return r[emailCol].toLowerCase()
    const name = nameCol >= 0 ? r[nameCol].toLowerCase() : ''
    return people.find((p) => p.name.toLowerCase() === name)?.email ?? (name ? `(no match for "${r[nameCol]}")` : '')
  }
  const hours = (s: string) => Number(String(s).replace(/[^\d.-]/g, ''))
  if (typeCol >= 0 && hoursCol >= 0) {
    return { rows: grid.slice(1).map((r) => ({ email: who(r), leaveType: r[typeCol], hours: hours(r[hoursCol]) })), note: '' }
  }
  const typeCols = head
    .map((h, i) => ({ i, t: types.find((t) => t.drawsBalance && (h === t.key || h === t.name.toLowerCase() || h.startsWith(t.key))) }))
    .filter((x): x is { i: number; t: LeaveType } => Boolean(x.t))
  if (!typeCols.length) return { rows: [], note: 'No column names a kind of leave. Use headers like "Email, Sick, Vacation" or "Email, Type, Hours".' }
  return {
    rows: grid.slice(1).flatMap((r) => typeCols.filter((c) => r[c.i] !== '' && r[c.i] !== undefined).map((c) => ({ email: who(r), leaveType: c.t.key, hours: hours(r[c.i]) }))),
    note: '',
  }
}

function ImportDialog({ people, types, onClose }: { people: Person[]; types: LeaveType[]; onClose: () => void }) {
  const [date, setDate] = useState(todayYmd())
  const [rows, setRows] = useState<{ email: string; leaveType: string; hours: number }[]>([])
  const [note, setNote] = useState('')
  const [result, setResult] = useState<OpeningResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const read = async (file: File | undefined) => {
    setResult(null)
    setError('')
    if (!file) return
    if (!/\.csv$/i.test(file.name)) {
      setError('Save the spreadsheet as CSV first (in Excel: File → Save As → CSV), then choose that file.')
      return
    }
    const parsed = sheetRows(parseCsv(await file.text()), people, types)
    setRows(parsed.rows)
    setNote(parsed.note)
    if (parsed.rows.length) await send(parsed.rows, true)
  }
  const send = async (r = rows, dryRun = true) => {
    setBusy(true)
    setError('')
    try {
      setResult(await leave.opening(date, r, dryRun))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Import opening balances</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            Use the finance spreadsheet saved as CSV: one row per person with a column per kind of leave (for example Name, Sick, Vacation), or Email, Type, Hours. Nothing is saved until you
            press Import. Importing the same date twice does not add the hours twice.
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <TextField label="Balances as of" type="date" size="small" value={date} onChange={(e) => setDate(e.target.value)} InputLabelProps={{ shrink: true }} />
            <Button component="label" variant="outlined">
              Choose CSV file
              <input hidden type="file" accept=".csv,text/csv" onChange={(e) => void read(e.target.files?.[0])} />
            </Button>
          </Stack>
          {note && <Alert severity="warning">{note}</Alert>}
          {error && <Alert severity="error">{error}</Alert>}
          {result && (
            <>
              <Alert severity={result.errors ? 'warning' : 'success'}>
                {result.dryRun
                  ? `${result.ready} ready to import, ${result.alreadyImported} already imported, ${result.errors} with a problem.`
                  : `Imported ${result.imported}. ${result.alreadyImported} were already in, ${result.errors} had a problem.`}
              </Alert>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Row</TableCell>
                      <TableCell>Person</TableCell>
                      <TableCell>Kind</TableCell>
                      <TableCell align="right">Hours</TableCell>
                      <TableCell>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {result.rows.map((r) => (
                      <TableRow key={r.row}>
                        <TableCell>{r.row}</TableCell>
                        <TableCell>{r.personName ?? r.email}</TableCell>
                        <TableCell>{r.leaveType}</TableCell>
                        <TableCell align="right">{r.hours}</TableCell>
                        <TableCell sx={{ color: r.status === 'error' ? 'warning.main' : undefined }}>{r.problem ?? r.status.replace('_', ' ')}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" disabled={busy || !result?.dryRun || !result.ready} onClick={() => void send(rows, false)}>
          Import {result?.dryRun ? result.ready : ''}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

// ─── Monthly statements ─────────────────────────────────────────────────────

function StatementsPanel() {
  const [month, setMonth] = useState(() => todayYmd().slice(0, 7))
  const [data, setData] = useState<Statements | null>(null)
  const [show, setShow] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!show) return
    leave
      .statements(month)
      .then((s) => {
        setData(s)
        setError('')
      })
      .catch((err) => setError(errorText(err)))
  }, [month, show])
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1.25}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography sx={{ fontWeight: 700, flex: 1 }}>Monthly statements</Typography>
          <TextField size="small" type="month" value={month} onChange={(e) => setMonth(e.target.value)} inputProps={{ 'aria-label': 'Month' }} />
          <FormControlLabel control={<Switch checked={show} onChange={(e) => setShow(e.target.checked)} />} label="Show" />
        </Stack>
        <Typography variant="body2" color="text.secondary">
          Everyone also sees their own statement on the Time off screen.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {show && data && (
          <Box sx={{ overflowX: 'auto' }}>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Person</TableCell>
                  <TableCell>Kind</TableCell>
                  <TableCell align="right">Start</TableCell>
                  <TableCell align="right">Earned</TableCell>
                  <TableCell align="right">Used</TableCell>
                  <TableCell align="right">Other</TableCell>
                  <TableCell align="right">End</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.statements.flatMap((s) =>
                  s.lines.map((l, i) => (
                    <TableRow key={`${s.person.id}-${l.leaveType.id}`}>
                      <TableCell>{i === 0 ? s.person.name : ''}</TableCell>
                      <TableCell>{l.leaveType.name}</TableCell>
                      <TableCell align="right">{fmtH(l.opening)}</TableCell>
                      <TableCell align="right">{fmtH(l.earned)}</TableCell>
                      <TableCell align="right">{fmtH(l.used)}</TableCell>
                      <TableCell align="right">{fmtH(l.otherChanges)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>
                        {fmtH(l.closing)}
                      </TableCell>
                    </TableRow>
                  )),
                )}
              </TableBody>
            </Table>
          </Box>
        )}
      </Stack>
    </Paper>
  )
}
