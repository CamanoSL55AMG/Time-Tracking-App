import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Divider, IconButton, Paper, Stack, Typography } from '@mui/material'
import { api, errorText, fmtDay, fmtTime, shiftWeek, type PersonWeek, type SheetStatus, type TimeException, type WeekSegment } from '../api'
import { RequestCard, RequestDialog } from './Requests'

// A tech's week: every segment by day, the total, and the Sign button. Signing says
// "these hours are right"; a manager approves after the week is over, and an
// approved week is locked.

export const statusLabel: Record<SheetStatus, string> = { open: 'Not signed', signed: 'Signed', approved: 'Approved' }
const statusColor: Record<SheetStatus, 'default' | 'info' | 'success'> = { open: 'default', signed: 'info', approved: 'success' }

export function StatusChip({ status, size = 'small' }: { status: SheetStatus; size?: 'small' | 'medium' }) {
  return <Chip size={size} color={statusColor[status]} label={statusLabel[status]} sx={{ fontWeight: 700 }} />
}

const h = (n: number) => (n === 0 ? '—' : n.toFixed(2))

export function WeekNav({ weekStart, weekEnd, onMove, disableNext }: { weekStart: string; weekEnd: string; onMove: (to: string) => void; disableNext?: boolean }) {
  return (
    <Stack direction="row" alignItems="center" spacing={1}>
      <IconButton aria-label="Previous week" onClick={() => onMove(shiftWeek(weekStart, -1))}>
        ‹
      </IconButton>
      <Typography sx={{ fontWeight: 700, flex: 1, textAlign: 'center' }}>
        {fmtDay(weekStart, { month: 'short', day: 'numeric' })} – {fmtDay(weekEnd, { month: 'short', day: 'numeric', year: 'numeric' })}
      </Typography>
      <IconButton aria-label="Next week" onClick={() => onMove(shiftWeek(weekStart, 1))} disabled={disableNext}>
        ›
      </IconButton>
    </Stack>
  )
}

export function ExceptionList({ items, showName }: { items: TimeException[]; showName?: boolean }) {
  if (!items.length) return null
  return (
    <Stack spacing={0.75}>
      {items.map((x, i) => (
        <Alert key={`${x.punchId ?? x.date}-${x.code}-${i}`} severity={x.severity === 'problem' ? 'warning' : 'info'} sx={{ py: 0 }}>
          {showName && <strong>{x.personName}: </strong>}
          {x.message}
        </Alert>
      ))}
    </Stack>
  )
}

/** Days of one person's week with their segments. */
export function WeekDetail({ week, onEdit }: { week: PersonWeek; onEdit?: (s: WeekSegment) => void }) {
  return (
    <Stack divider={<Divider flexItem />} spacing={1}>
      {week.days.map((d) => (
        <Box key={d.date}>
          <Stack direction="row" alignItems="baseline">
            <Typography variant="body2" sx={{ fontWeight: 700, flex: 1 }}>
              {fmtDay(d.date)}
            </Typography>
            <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700 }} color={d.hours ? 'text.primary' : 'text.disabled'}>
              {h(d.hours)}
            </Typography>
          </Stack>
          {d.segments.map((s) => (
            <Stack
              key={s.id}
              direction="row"
              spacing={1}
              onClick={onEdit ? () => onEdit(s) : undefined}
              sx={{ pl: 1, borderRadius: 1, ...(onEdit ? { cursor: 'pointer', '&:hover': { bgcolor: 'action.hover' } } : {}) }}
            >
              <Typography variant="caption" color="text.secondary" sx={{ width: 118, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {fmtTime(s.clockIn)} – {s.clockOut ? fmtTime(s.clockOut) : 'now'}
              </Typography>
              <Typography variant="caption" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {s.phase?.short ?? '—'} · {s.job.name}
                {s.edited && ' · corrected'}
                {s.source === 'lead' && ' · by crew lead'}
              </Typography>
            </Stack>
          ))}
        </Box>
      ))}
      <Stack direction="row" alignItems="baseline">
        <Typography sx={{ fontWeight: 700, flex: 1 }}>Week total</Typography>
        <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{week.hours.toFixed(2)} h</Typography>
      </Stack>
    </Stack>
  )
}

export function signOffLine(w: { status: SheetStatus; signedAt: string | null; approvedAt: string | null; approvedBy: string | null; note: string }) {
  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '')
  if (w.status === 'approved') return `Approved ${when(w.approvedAt)}${w.approvedBy ? ` by ${w.approvedBy}` : ''}. Locked.`
  if (w.status === 'signed') return `Signed ${when(w.signedAt)}. Waiting for approval.`
  return w.note ? w.note : ''
}

export default function WeekPage() {
  const [week, setWeek] = useState<PersonWeek | null>(null)
  const [at, setAt] = useState<string | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  // Asking for a change: a segment to fix, or a day to add missing time to.
  const [asking, setAsking] = useState<{ segment?: WeekSegment; day?: string } | null>(null)
  const [sentNote, setSentNote] = useState('')

  const load = useCallback(async (to?: string) => {
    setError('')
    try {
      setWeek(await api.myWeek(to))
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void load(at)
  }, [at, load])

  const sign = async () => {
    if (!week) return
    setBusy(true)
    setError('')
    try {
      setWeek(await api.signWeek(week.weekStart))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!week) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
      </Stack>
    )
  }

  const line = signOffLine(week)
  const canSign = week.status !== 'approved' && !week.openSegment && week.hours > 0
  const today = new Date().toLocaleDateString('en-CA')
  const addDay = week.days.some((d) => d.date === today) ? today : week.weekStart
  const withdraw = async (id: string) => {
    setError('')
    try {
      await api.withdrawRequest(id)
      await load(week.weekStart)
    } catch (err) {
      setError(errorText(err))
    }
  }

  return (
    <Stack spacing={2}>
      <WeekNav weekStart={week.weekStart} weekEnd={week.weekEnd} onMove={setAt} disableNext={!week.weekOver} />
      <Paper sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Stack direction="row" alignItems="center" spacing={1}>
            <StatusChip status={week.status} />
            <Box sx={{ flex: 1 }} />
            <Typography variant="h6" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {week.hours.toFixed(2)} h
            </Typography>
          </Stack>
          {line && (
            <Typography variant="body2" color="text.secondary">
              {line}
            </Typography>
          )}
          <WeekDetail week={week} onEdit={(s) => setAsking({ segment: s })} />
          <Typography variant="caption" color="text.secondary">
            Something wrong? Tap the segment to ask for a change. Forgot to punch?{' '}
            <Box component="button" type="button" onClick={() => setAsking({ day: addDay })} sx={{ all: 'unset', color: 'primary.main', fontWeight: 600, cursor: 'pointer' }}>
              Add missing time
            </Box>
            . Your supervisor approves changes before they count.
          </Typography>
        </Stack>
      </Paper>

      {sentNote && (
        <Alert severity="success" onClose={() => setSentNote('')}>
          {sentNote}
        </Alert>
      )}
      {week.requests.length > 0 && (
        <Stack spacing={1}>
          <Typography variant="subtitle2">Your change requests</Typography>
          {week.requests.map((r) => (
            <RequestCard
              key={r.id}
              req={r}
              actions={
                r.status === 'pending' ? (
                  <Box sx={{ textAlign: 'right' }}>
                    <Button size="small" onClick={() => void withdraw(r.id)}>
                      Withdraw
                    </Button>
                  </Box>
                ) : undefined
              }
            />
          ))}
        </Stack>
      )}

      <ExceptionList items={week.exceptions.filter((x) => x.code !== 'sent_late')} />
      {error && <Alert severity="error">{error}</Alert>}

      {week.status !== 'approved' && (
        <Stack spacing={0.75}>
          <Button size="large" variant="contained" disabled={busy || !canSign || week.status === 'signed'} onClick={sign} sx={{ py: 1.5 }}>
            {week.status === 'signed' ? 'Signed' : busy ? 'Signing…' : 'Sign this week'}
          </Button>
          <Typography variant="caption" color="text.secondary" textAlign="center">
            {week.openSegment
              ? 'Clock out before signing.'
              : week.weekOver
                ? 'Signing says these hours are right. If something is wrong, tell your manager before signing.'
                : 'You can sign at the end of your last day this week. Any later punch sends it back for signing.'}
          </Typography>
        </Stack>
      )}

      {asking && (
        <RequestDialog
          segment={asking.segment}
          day={asking.day}
          onClose={() => setAsking(null)}
          onSent={() => {
            setAsking(null)
            setSentNote('Sent. Your supervisor will approve it or get back to you.')
            void load(week.weekStart)
          }}
        />
      )}
    </Stack>
  )
}
