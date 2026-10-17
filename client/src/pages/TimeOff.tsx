import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  Link,
  MenuItem,
  Paper,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { errorText, fmtDay, fmtH, leave, todayYmd, type LeaveBalance, type LeaveRequest, type MyLeave, type Person, type Statements } from '../api'

// Time off: what you have, what you have asked for, and asking for more. Leads
// and managers also see requests waiting for them.

const STATUS_COLOR: Record<LeaveRequest['status'], 'info' | 'success' | 'default' | 'warning'> = {
  requested: 'info',
  approved: 'success',
  denied: 'warning',
  cancelled: 'default',
}
const STATUS_LABEL: Record<LeaveRequest['status'], string> = {
  requested: 'Waiting',
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled',
}

const range = (r: { startDate: string; endDate: string }) => (r.startDate === r.endDate ? fmtDay(r.startDate) : `${fmtDay(r.startDate)} – ${fmtDay(r.endDate)}`)

/** Weekdays from start to end, inclusive: the usual guess for hours at 8 a day. */
function weekdays(start: string, end: string): number {
  if (!start || !end || end < start) return 0
  let n = 0
  for (let d = new Date(`${start}T12:00:00`); d <= new Date(`${end}T12:00:00`); d.setDate(d.getDate() + 1)) {
    if (d.getDay() !== 0 && d.getDay() !== 6) n += 1
  }
  return n
}

export default function TimeOffPage({ me }: { me: Person }) {
  const canApprove = me.scopes.includes('leave:approve')
  const [data, setData] = useState<MyLeave | null>(null)
  const [pending, setPending] = useState<LeaveRequest[]>([])
  const [error, setError] = useState('')
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [mine, waiting] = await Promise.all([leave.mine(), canApprove ? leave.requests({ status: 'requested' }) : Promise.resolve([])])
      setData(mine)
      setPending(waiting.filter((r) => r.personId !== me.id))
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [canApprove, me.id])

  useEffect(() => {
    void load()
  }, [load])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!data) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }} spacing={2}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
        {error && <Button onClick={() => void load()}>Try again</Button>}
      </Stack>
    )
  }

  const banks = data.types.filter((t) => t.leaveType.drawsBalance)
  const hasSick = data.types.some((t) => t.leaveType.statutory === 'wa_sick')
  const today = todayYmd()

  return (
    <Stack spacing={2.5}>
      {error && (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {hasSick && !data.sickNoticeAcknowledgedAt && <SickNotice busy={busy} onAck={() => void act(leave.acknowledge)} />}

      {pending.length > 0 && (
        <Stack spacing={1.25}>
          <Typography variant="overline" color="text.secondary">
            Waiting for your OK
          </Typography>
          {pending.map((r) => (
            <PendingCard key={r.id} request={r} busy={busy} onDecide={(action, note) => void act(() => leave.decide(r.id, action, note))} />
          ))}
          <Divider />
        </Stack>
      )}

      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 1.5 }}>
        {banks.map((b) => (
          <BalanceCard key={b.leaveType.id} b={b} />
        ))}
      </Box>

      <Button variant="contained" size="large" onClick={() => setAsking(true)}>
        Ask for time off
      </Button>

      <Stack spacing={1}>
        <Typography variant="overline" color="text.secondary">
          Your requests
        </Typography>
        {data.requests.length === 0 && <Typography color="text.secondary">Nothing requested yet.</Typography>}
        {data.requests.map((r) => {
          const canCancel = r.status === 'requested' || (r.status === 'approved' && r.startDate > today)
          return (
            <Paper key={r.id} variant="outlined" sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }} noWrap>
                    {r.leaveType.name} · {fmtH(r.hours)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {range(r)}
                    {r.decisionNote && ` · ${r.decisionNote}`}
                  </Typography>
                </Box>
                <Chip size="small" color={STATUS_COLOR[r.status]} label={STATUS_LABEL[r.status]} />
                {canCancel && (
                  <Button size="small" disabled={busy} onClick={() => void act(() => leave.decide(r.id, 'cancel'))}>
                    Cancel
                  </Button>
                )}
              </Stack>
            </Paper>
          )
        })}
      </Stack>

      <MonthStatement />

      {asking && (
        <RequestDialog
          types={data.types}
          onClose={() => setAsking(false)}
          onSent={async () => {
            setAsking(false)
            await load()
          }}
        />
      )}
    </Stack>
  )
}

function BalanceCard({ b }: { b: LeaveBalance }) {
  const notYet = b.usableNow === false
  return (
    <Paper sx={{ p: 1.75 }}>
      <Typography variant="body2" color="text.secondary" noWrap>
        {b.leaveType.name}
      </Typography>
      <Typography variant="h5" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {fmtH(b.available ?? b.balance)}
      </Typography>
      <Typography variant="caption" color="text.secondary" component="div">
        {b.pending > 0 ? `${fmtH(b.pending)} waiting · ` : ''}
        {fmtH(b.earnedThisYear)} earned this year
      </Typography>
      {notYet && b.usableFrom && (
        <Typography variant="caption" color="warning.main" component="div">
          Usable from {fmtDay(b.usableFrom)}
        </Typography>
      )}
    </Paper>
  )
}

function SickNotice({ busy, onAck }: { busy: boolean; onAck: () => void }) {
  return (
    <Alert severity="info">
      <Stack spacing={1}>
        <Typography sx={{ fontWeight: 700 }}>Your paid sick leave</Typography>
        <Typography variant="body2">
          You earn at least 1 hour of paid sick leave for every 40 hours you work, and can use it from your 90th day. Up to 40 unused hours carry into next year. You do
          not have to say why you are using it here. Full details from Washington L&amp;I:{' '}
          <Link href="https://lni.wa.gov/workers-rights/leave/paid-sick-leave" target="_blank" rel="noreferrer">
            lni.wa.gov
          </Link>
          .
        </Typography>
        <Box>
          <Button variant="outlined" size="small" disabled={busy} onClick={onAck}>
            I&apos;ve read this
          </Button>
        </Box>
      </Stack>
    </Alert>
  )
}

function PendingCard({ request: r, busy, onDecide }: { request: LeaveRequest; busy: boolean; onDecide: (action: 'approve' | 'deny', note: string) => void }) {
  const [denying, setDenying] = useState(false)
  const [note, setNote] = useState('')
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1}>
        <Typography sx={{ fontWeight: 700 }}>
          {r.person.name} · {r.leaveType.name}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {range(r)} · {fmtH(r.hours)}
          {r.note && ` · "${r.note}"`}
        </Typography>
        {denying ? (
          <Stack spacing={1}>
            <TextField label="Why not" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
            <Stack direction="row" spacing={1}>
              <Button onClick={() => setDenying(false)}>Cancel</Button>
              <Button variant="contained" color="warning" disabled={busy || !note.trim()} onClick={() => onDecide('deny', note.trim())}>
                Deny
              </Button>
            </Stack>
          </Stack>
        ) : (
          <Stack direction="row" spacing={1}>
            <Button variant="outlined" color="warning" sx={{ flex: 1 }} onClick={() => setDenying(true)}>
              Deny
            </Button>
            <Button variant="contained" color="success" sx={{ flex: 1 }} disabled={busy} onClick={() => onDecide('approve', '')}>
              Approve
            </Button>
          </Stack>
        )}
      </Stack>
    </Paper>
  )
}

function RequestDialog({ types, onClose, onSent }: { types: LeaveBalance[]; onClose: () => void; onSent: () => Promise<void> }) {
  const [typeId, setTypeId] = useState(types[0]?.leaveType.id ?? '')
  const [start, setStart] = useState(todayYmd())
  const [end, setEnd] = useState(todayYmd())
  const [hoursText, setHoursText] = useState('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const guess = useMemo(() => weekdays(start, end) * 8, [start, end])
  const hours = hoursText === '' ? guess : Number(hoursText)
  const chosen = types.find((t) => t.leaveType.id === typeId)

  const send = async () => {
    setBusy(true)
    setError('')
    try {
      await leave.request({ leaveTypeId: typeId, startDate: start, endDate: end, hours, note: note.trim() })
      await onSent()
    } catch (err) {
      setError(errorText(err))
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Ask for time off</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <TextField select label="Kind" value={typeId} onChange={(e) => setTypeId(e.target.value)}>
            {types.map((t) => (
              <MenuItem key={t.leaveType.id} value={t.leaveType.id}>
                {t.leaveType.name}
                {t.leaveType.drawsBalance && t.available !== null ? ` (${fmtH(t.available)} available)` : ''}
              </MenuItem>
            ))}
          </TextField>
          <Stack direction="row" spacing={1}>
            <TextField
              label="From"
              type="date"
              value={start}
              onChange={(e) => {
                setStart(e.target.value)
                if (end < e.target.value) setEnd(e.target.value)
              }}
              InputLabelProps={{ shrink: true }}
              sx={{ flex: 1 }}
            />
            <TextField label="To" type="date" value={end} onChange={(e) => setEnd(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ flex: 1 }} />
          </Stack>
          <TextField
            label="Hours"
            inputMode="decimal"
            value={hoursText}
            placeholder={String(guess)}
            onChange={(e) => setHoursText(e.target.value)}
            helperText={hoursText === '' ? `${guess} h: 8 for each weekday. Change it for part days.` : ' '}
          />
          <TextField
            label="Note (optional)"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            helperText={chosen?.leaveType.statutory === 'wa_sick' ? 'You do not need to give a reason for sick leave. Do not add medical details.' : ' '}
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={busy || !typeId || !(hours > 0) || end < start} onClick={() => void send()}>
          Send request
        </Button>
      </DialogActions>
    </Dialog>
  )
}

function MonthStatement() {
  const [month, setMonth] = useState(() => todayYmd().slice(0, 7))
  const [data, setData] = useState<Statements | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    leave
      .myStatement(month)
      .then((s) => {
        setData(s)
        setError('')
      })
      .catch((err) => setError(errorText(err)))
  }, [month])
  const lines = data?.statements[0]?.lines ?? []
  return (
    <Paper sx={{ p: 2 }}>
      <Stack spacing={1.25}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography sx={{ fontWeight: 700, flex: 1 }}>Monthly statement</Typography>
          <TextField size="small" type="month" value={month} onChange={(e) => setMonth(e.target.value)} inputProps={{ 'aria-label': 'Month' }} />
        </Stack>
        {error && <Alert severity="error">{error}</Alert>}
        {!error && lines.length === 0 && <Typography color="text.secondary">No leave activity up to this month.</Typography>}
        {lines.map((l) => (
          <Box key={l.leaveType.id} sx={{ display: 'grid', gridTemplateColumns: '1fr repeat(4, auto)', columnGap: 2, rowGap: 0.25, fontVariantNumeric: 'tabular-nums' }}>
            <Typography sx={{ fontWeight: 600 }}>{l.leaveType.name}</Typography>
            {['Start', 'Earned', 'Used', 'End'].map((h) => (
              <Typography key={h} variant="caption" color="text.secondary" sx={{ textAlign: 'right' }}>
                {h}
              </Typography>
            ))}
            <span />
            <Typography sx={{ textAlign: 'right' }}>{fmtH(l.opening)}</Typography>
            <Typography sx={{ textAlign: 'right' }}>{fmtH(l.earned)}</Typography>
            <Typography sx={{ textAlign: 'right' }}>{fmtH(l.used)}</Typography>
            <Typography sx={{ textAlign: 'right', fontWeight: 700 }}>{fmtH(l.closing)}</Typography>
            {l.otherChanges !== 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ gridColumn: '1 / -1' }}>
                Includes {fmtH(l.otherChanges)} from opening balances, corrections or carryover
              </Typography>
            )}
          </Box>
        ))}
      </Stack>
    </Paper>
  )
}
