import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Paper,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TableContainer,
  TextField,
  Typography,
} from '@mui/material'
import { api, errorText, fmtDay, fmtTime, type PersonWeek, type WeekSegment, type WeekSheet, type WeekSheetRow } from '../api'
import { ExceptionList, StatusChip, WeekDetail, WeekNav, signOffLine } from './Week'
import { DecideButtons, RequestCard } from './Requests'
import { ExpenseApprovals } from './Expenses'
import { TeamOpenItems } from './items'
import type { ChangeRequest, ServiceBilling } from '../api'

// The approver's week: everyone's hours by day, who has signed, what needs a look.
// Approve the rows that are right; an approved week is locked until reopened.
// Leads can look; only managers and payroll approve.

export default function ReviewPage({ canApprove, canEdit, canApproveExpenses = false, meId }: { canApprove: boolean; canEdit: boolean; canApproveExpenses?: boolean; meId?: string }) {
  const [sheet, setSheet] = useState<WeekSheet | null>(null)
  const [at, setAt] = useState<string | undefined>(undefined)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [open, setOpen] = useState<WeekSheetRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [showNotes, setShowNotes] = useState(false)
  // Change requests waiting for a decision, from any week.
  const [requests, setRequests] = useState<ChangeRequest[]>([])

  const load = useCallback(async (to?: string) => {
    setError('')
    try {
      const [s, reqs] = await Promise.all([api.weekSheet(to), api.pendingRequests()])
      setSheet(s)
      setRequests(reqs)
      setPicked(new Set())
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    // Open on last week: that is the one waiting for approval.
    if (at === undefined) {
      const d = new Date()
      d.setDate(d.getDate() - 7)
      setAt(d.toLocaleDateString('en-CA'))
      return
    }
    void load(at)
  }, [at, load])

  const approvable = (r: WeekSheetRow) => canApprove && Boolean(sheet?.weekOver) && r.status !== 'approved' && !r.openSegment
  const selectable = useMemo(() => (sheet?.rows ?? []).filter(approvable), [sheet, canApprove]) // eslint-disable-line react-hooks/exhaustive-deps

  const approve = async (ids: string[]) => {
    if (!sheet || !ids.length) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      const r = await api.approve(ids, sheet.weekStart)
      const failed = r.results.filter((x) => !x.ok)
      setNotice(`${r.approved} approved.${failed.length ? ` Not approved: ${failed.map((f) => f.message).join(' ')}` : ''}`)
      setOpen(null)
      await load(sheet.weekStart)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!sheet) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
      </Stack>
    )
  }

  const problems = sheet.exceptions.filter((x) => x.severity === 'problem')
  const notes = sheet.exceptions.filter((x) => x.severity === 'note')
  const total = sheet.rows.reduce((s, r) => s + r.hours, 0)
  const allPicked = selectable.length > 0 && selectable.every((r) => picked.has(r.person.id))

  return (
    <Stack spacing={2}>
      <WeekNav weekStart={sheet.weekStart} weekEnd={sheet.weekEnd} onMove={setAt} />

      <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Chip label={`${sheet.rows.length} people · ${total.toFixed(1)} h`} />
        <Chip color="success" variant="outlined" label={`${sheet.counts.approved} approved`} />
        <Chip color="info" variant="outlined" label={`${sheet.counts.signed} signed`} />
        <Chip variant="outlined" label={`${sheet.counts.open} not signed`} />
        {!sheet.weekOver && <Chip color="warning" variant="outlined" label="Week not over yet" />}
      </Stack>

      {requests.length > 0 && (
        <Stack spacing={1}>
          <Typography variant="subtitle2">Change requests waiting ({requests.length})</Typography>
          {requests.map((r) => (
            <RequestCard
              key={r.id}
              req={r}
              showName
              actions={canApprove ? <DecideButtons req={r} onDone={() => void load(sheet.weekStart)} /> : undefined}
            />
          ))}
        </Stack>
      )}

      <TeamOpenItems />

      {notice && (
        <Alert severity="success" onClose={() => setNotice('')}>
          {notice}
        </Alert>
      )}
      {error && <Alert severity="error">{error}</Alert>}

      <Paper>
        <TableContainer>
          <Table size="small" sx={{ '& td, & th': { px: 1, whiteSpace: 'nowrap' } }}>
            <TableHead>
              <TableRow>
                {canApprove && (
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={allPicked}
                      disabled={!selectable.length}
                      onChange={() => setPicked(allPicked ? new Set() : new Set(selectable.map((r) => r.person.id)))}
                      inputProps={{ 'aria-label': 'Select all ready to approve' }}
                    />
                  </TableCell>
                )}
                <TableCell>Person</TableCell>
                {sheet.days.map((d) => (
                  <TableCell key={d} align="right">
                    {fmtDay(d, { weekday: 'short' })}
                  </TableCell>
                ))}
                <TableCell align="right">Total</TableCell>
                <TableCell>Status</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sheet.rows.map((r) => (
                <TableRow key={r.person.id} hover sx={{ cursor: 'pointer' }} onClick={() => setOpen(r)}>
                  {canApprove && (
                    <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        size="small"
                        checked={picked.has(r.person.id)}
                        disabled={!approvable(r)}
                        onChange={() => {
                          const next = new Set(picked)
                          if (next.has(r.person.id)) next.delete(r.person.id)
                          else next.add(r.person.id)
                          setPicked(next)
                        }}
                        inputProps={{ 'aria-label': `Select ${r.person.name}` }}
                      />
                    </TableCell>
                  )}
                  <TableCell sx={{ fontWeight: 600 }}>
                    <Badge color="warning" badgeContent={r.problems} invisible={!r.problems} sx={{ '& .MuiBadge-badge': { right: -12 } }}>
                      {r.person.name}
                    </Badge>
                  </TableCell>
                  {r.daily.map((h, i) => (
                    <TableCell key={i} align="right" sx={{ fontVariantNumeric: 'tabular-nums', color: h ? (h > 12 ? 'warning.main' : 'text.primary') : 'text.disabled' }}>
                      {h ? h.toFixed(1) : '—'}
                    </TableCell>
                  ))}
                  <TableCell align="right" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
                    {r.hours.toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      {r.openSegment ? <Chip size="small" color="warning" label="On the clock" /> : <StatusChip status={r.status} />}
                      {r.pendingRequests > 0 && <Chip size="small" color="warning" variant="outlined" label={`${r.pendingRequests} change${r.pendingRequests === 1 ? '' : 's'} waiting`} />}
                    </Stack>
                  </TableCell>
                </TableRow>
              ))}
              {!sheet.rows.length && (
                <TableRow>
                  <TableCell colSpan={canApprove ? 11 : 10} sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>
                    Nobody punched this week.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {canApprove && (
        <Stack direction="row" spacing={1} alignItems="center">
          <Button variant="contained" disabled={busy || !picked.size} onClick={() => approve([...picked])}>
            {busy ? 'Approving…' : `Approve ${picked.size || ''}`.trim()}
          </Button>
          <Typography variant="caption" color="text.secondary">
            {sheet.weekOver ? 'Approved weeks are locked until reopened. Rows still on the clock cannot be approved.' : 'A week can be approved once it is over.'}
          </Typography>
        </Stack>
      )}

      {sheet.quiet.length > 0 && (
        <Typography variant="body2" color="text.secondary">
          No punches this week: {sheet.quiet.map((p) => p.name).join(', ')}
        </Typography>
      )}

      {problems.length > 0 && (
        <Box>
          <Typography variant="subtitle2" gutterBottom>
            Needs a look ({problems.length})
          </Typography>
          <ExceptionList items={problems} showName />
        </Box>
      )}
      {notes.length > 0 && (
        <Box>
          <Button size="small" onClick={() => setShowNotes(!showNotes)}>
            {showNotes ? 'Hide' : 'Show'} {notes.length} note{notes.length === 1 ? '' : 's'} (corrections, punches away from the site, punches sent late)
          </Button>
          {showNotes && <ExceptionList items={notes} showName />}
        </Box>
      )}

      <ExpenseApprovals canApprove={canApproveExpenses} meId={meId} />

      <ServiceBillingPanel from={sheet.weekStart} to={sheet.weekEnd} />

      {open && <PersonDialog row={open} weekStart={sheet.weekStart} canApprove={canApprove} canEdit={canEdit} approvable={approvable(open)} busy={busy} onApprove={() => approve([open.person.id])} onClose={() => setOpen(null)} onChanged={() => void load(sheet.weekStart)} />}
    </Stack>
  )
}

function PersonDialog({
  row,
  weekStart,
  canApprove,
  canEdit,
  approvable,
  busy,
  onApprove,
  onClose,
  onChanged,
}: {
  row: WeekSheetRow
  weekStart: string
  canApprove: boolean
  canEdit: boolean
  approvable: boolean
  busy: boolean
  onApprove: () => void
  onClose: () => void
  onChanged: () => void
}) {
  const [week, setWeek] = useState<PersonWeek | null>(null)
  const [error, setError] = useState('')
  const [reopening, setReopening] = useState(false)
  const [reason, setReason] = useState('')
  const [working, setWorking] = useState(false)
  const [editing, setEditing] = useState<WeekSegment | null>(null)

  const reload = useCallback(() => {
    api.personWeek(row.person.id, weekStart).then(setWeek, (err) => setError(errorText(err)))
  }, [row.person.id, weekStart])
  useEffect(reload, [reload])

  const reopen = async () => {
    setWorking(true)
    setError('')
    try {
      setWeek(await api.reopen(row.person.id, weekStart, reason))
      setReopening(false)
      setReason('')
      onChanged()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setWorking(false)
    }
  }

  const line = week ? signOffLine(week) : ''
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Box sx={{ flex: 1 }}>{row.person.name}</Box>
          {week && <StatusChip status={week.status} />}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {!week && !error && <CircularProgress size={24} />}
        {week && (
          <Stack spacing={2}>
            {line && (
              <Typography variant="body2" color="text.secondary">
                {line}
              </Typography>
            )}
            {week.status !== 'signed' && week.status !== 'approved' && (
              <Typography variant="body2" color="text.secondary">
                Not signed by {row.person.name.split(' ')[0]} yet. You can still approve.
              </Typography>
            )}
            <WeekDetail week={week} onEdit={canEdit && week.status !== 'approved' ? setEditing : undefined} />
            <ExceptionList items={week.exceptions} />
            {week.requests.length > 0 && (
              <Stack spacing={1}>
                <Typography variant="subtitle2">Change requests this week</Typography>
                {week.requests.map((q) => (
                  <RequestCard
                    key={q.id}
                    req={q}
                    actions={
                      canApprove && q.status === 'pending' ? (
                        <DecideButtons
                          req={q}
                          onDone={() => {
                            reload()
                            onChanged()
                          }}
                        />
                      ) : undefined
                    }
                  />
                ))}
              </Stack>
            )}
            {canEdit && (
              <Typography variant="caption" color="text.secondary">
                {week.status === 'approved' ? 'Reopen the week to correct a segment.' : 'Tap a segment to correct its times. Every correction keeps a reason.'}
              </Typography>
            )}
            {reopening && (
              <TextField
                label="Why reopen this week?"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                autoFocus
                placeholder="e.g. Missed lunch on Tuesday, fixing the clock-out"
                inputProps={{ maxLength: 300 }}
              />
            )}
          </Stack>
        )}
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        {canApprove && week && week.status !== 'open' && !reopening && (
          <Button color="warning" onClick={() => setReopening(true)}>
            Reopen
          </Button>
        )}
        {reopening && (
          <Button color="warning" variant="contained" disabled={working || !reason.trim()} onClick={reopen}>
            {working ? 'Reopening…' : 'Reopen week'}
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose}>Close</Button>
        {canApprove && approvable && (
          <Button variant="contained" disabled={busy} onClick={onApprove}>
            Approve
          </Button>
        )}
      </DialogActions>
      {editing && (
        <EditSegment
          segment={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null)
            reload()
            onChanged()
          }}
        />
      )}
    </Dialog>
  )
}

/** "2026-10-12T07:05" in this browser's time zone, for a datetime-local input. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

function EditSegment({ segment, onClose, onSaved }: { segment: WeekSegment; onClose: () => void; onSaved: () => void }) {
  const [clockIn, setClockIn] = useState(toLocalInput(segment.clockIn))
  const [clockOut, setClockOut] = useState(toLocalInput(segment.clockOut))
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await api.editPunch(segment.id, {
        clockIn: new Date(clockIn).toISOString(),
        clockOut: clockOut ? new Date(clockOut).toISOString() : null,
        reason,
      })
      onSaved()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Correct segment</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {segment.phase?.name ?? 'No phase'} · {segment.job.name} · was {fmtTime(segment.clockIn)} – {segment.clockOut ? fmtTime(segment.clockOut) : 'still open'}
          </Typography>
          <TextField label="Clock in" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField
            label="Clock out"
            type="datetime-local"
            value={clockOut}
            onChange={(e) => setClockOut(e.target.value)}
            InputLabelProps={{ shrink: true }}
            helperText={segment.clockOut ? '' : 'Set the time they really stopped, to close a missed clock-out'}
          />
          <TextField label="Reason (required)" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Forgot to clock out, left site at 3:30" inputProps={{ maxLength: 300 }} />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={saving || !reason.trim() || !clockIn} onClick={save}>
          {saving ? 'Saving…' : 'Save correction'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** What this week's service calls bill: flat travel, trip charge, time past the included hour. */
function ServiceBillingPanel({ from, to }: { from: string; to: string }) {
  const [data, setData] = useState<ServiceBilling | null>(null)
  const [show, setShow] = useState(false)
  useEffect(() => {
    setData(null)
    // Hidden for people without reports access, and for weeks with no service calls.
    api.serviceBilling(from, to).then(setData, () => setData(null))
  }, [from, to])
  if (!data || !data.rows.length) return null
  const h = (n: number) => n.toFixed(2)
  return (
    <Box>
      <Button size="small" onClick={() => setShow(!show)}>
        {show ? 'Hide' : 'Show'} service billing ({data.totals.calls} call{data.totals.calls === 1 ? '' : 's'}, {h(data.totals.billedTravelHours)} h travel,{' '}
        {data.totals.tripCharges} trip charge{data.totals.tripCharges === 1 ? '' : 's'}, {h(data.totals.billableHours)} h extra)
      </Button>
      {show && (
        <Paper sx={{ mt: 1 }}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>Day</TableCell>
                  <TableCell>Call</TableCell>
                  <TableCell>Techs</TableCell>
                  <TableCell align="right">Travel billed</TableCell>
                  <TableCell align="right">Trip charge</TableCell>
                  <TableCell align="right">Extra hours</TableCell>
                  <TableCell align="right">Real drive / site</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.rows.map((r) => (
                  <TableRow key={`${r.jobId}-${r.day}`}>
                    <TableCell>{fmtDay(r.day)}</TableCell>
                    <TableCell>
                      {r.jobCode && r.jobCode !== r.jobName ? `${r.jobCode} ` : ''}
                      {r.jobName}
                      {r.open && ' (still on the clock)'}
                    </TableCell>
                    <TableCell>{r.techs.join(', ')}</TableCell>
                    <TableCell align="right">{h(r.billedTravelHours)}</TableCell>
                    <TableCell align="right">{r.tripCharges}</TableCell>
                    <TableCell align="right">{h(r.billableHours)}</TableCell>
                    <TableCell align="right">
                      {h(r.actualTravelHours)} / {h(r.actualOnSiteHours)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 1 }}>
            Travel {h(data.rules.travelHours)} h per tech who drove to the call; the trip charge covers the first {h(data.rules.includedHours)} h on site;
            time past that in {data.rules.incrementMinutes}-minute steps. Payroll pays the real times.
          </Typography>
        </Paper>
      )}
    </Box>
  )
}
