import { useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  Stack,
  TextField,
  Typography,
} from '@mui/material'
import { api, errorText, fmtDay, fmtTime, toLocalInput, type WeekSegment } from '../api'
import { useTimeCheck } from '../components/TimeCheck'

// Fixing your own day (Jake's ask, Art 2026-11-09). Open an earlier day, fix one
// segment, then step forward through each switch until the day is right. A change
// counts at once: no approval first, but the old times are kept and your supervisor
// sees the segment as edited. Where two segments meet (a job or phase switch), moving
// that time moves both sides, so no gap or overlap appears by accident.

const meets = (a: WeekSegment | undefined, b: WeekSegment | undefined) =>
  Boolean(a?.clockOut && b && new Date(a.clockOut).getTime() === new Date(b.clockIn).getTime())

const label = (s: WeekSegment) => `${s.phase?.name ?? 'No phase'} · ${s.job.name}`

export default function DayFix({
  date,
  segments,
  startId,
  today,
  onClose,
  onChanged,
}: {
  date: string
  /** The day's segments as they are now, oldest first. Refreshed by the parent after each save. */
  segments: WeekSegment[]
  /** The segment to start on. */
  startId?: string
  /** Today's local date (YYYY-MM-DD): a segment still open today ends with Clock out, not here. */
  today: string
  onClose: () => void
  onChanged: () => Promise<void>
}) {
  const [currentId, setCurrentId] = useState(startId ?? segments[0]?.id ?? '')
  const i = Math.max(0, segments.findIndex((s) => s.id === currentId))
  const seg = segments[i]
  const prev = segments[i - 1]
  const next = segments[i + 1]

  const [clockIn, setClockIn] = useState('')
  const [clockOut, setClockOut] = useState('')
  const [keepJoined, setKeepJoined] = useState(true)
  // Typed once and kept while stepping through the day.
  const [reason, setReason] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const timeCheck = useTimeCheck()

  // Load the times of the segment in front of you (again after a save moved them).
  useEffect(() => {
    if (!seg) return
    setClockIn(toLocalInput(seg.clockIn))
    setClockOut(toLocalInput(seg.clockOut))
    setKeepJoined(true)
    setError('')
  }, [seg?.id, seg?.clockIn, seg?.clockOut]) // eslint-disable-line react-hooks/exhaustive-deps

  const openToday = Boolean(seg && !seg.clockOut && date === today)
  const inChanged = Boolean(seg && clockIn && clockIn !== toLocalInput(seg.clockIn))
  const outChanged = Boolean(seg && clockOut && clockOut !== toLocalInput(seg.clockOut))
  const joinedBefore = meets(prev, seg)
  const joinedAfter = meets(seg, next)
  const touchesSwitch = (inChanged && joinedBefore) || (outChanged && joinedAfter)

  // Off-the-clock stretches between segments, so a gap is never hidden.
  const rows = useMemo(() => {
    const out: ({ kind: 'seg'; s: WeekSegment } | { kind: 'gap'; from: string; to: string })[] = []
    segments.forEach((s, k) => {
      const p = segments[k - 1]
      if (p?.clockOut && new Date(s.clockIn).getTime() > new Date(p.clockOut).getTime()) out.push({ kind: 'gap', from: p.clockOut, to: s.clockIn })
      out.push({ kind: 'seg', s })
    })
    return out
  }, [segments])

  if (!seg) {
    return (
      <Dialog open onClose={onClose} fullWidth maxWidth="xs">
        <DialogTitle>Fix {fmtDay(date)}</DialogTitle>
        <DialogContent>
          <Typography color="text.secondary">No time on this day.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose}>Close</Button>
        </DialogActions>
      </Dialog>
    )
  }

  // The times to save come in as arguments: the AM/PM check may have switched one.
  const save = async (ci: string, co: string) => {
    setClockIn(ci)
    setClockOut(co)
    setSaving(true)
    setError('')
    setNote('')
    try {
      const iso = (v: string) => new Date(v).toISOString()
      const r = await api.fixMyTime(seg.id, {
        clockIn: ci && ci !== toLocalInput(seg.clockIn) ? iso(ci) : undefined,
        clockOut: co && co !== toLocalInput(seg.clockOut) ? iso(co) : undefined,
        keepJoined,
        reason,
      })
      await onChanged()
      const moved = r.changed.length - 1
      setNote(
        `Saved.${moved > 0 ? ` The ${moved === 2 ? 'segments' : 'segment'} next to it moved too.` : ''}${r.opensGap ? ' You are off the clock in between now.' : ''}${next ? ' Next segment:' : ' That was the last one of the day.'}`,
      )
      // Step forward to the next switch.
      if (next) setCurrentId(next.id)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Fix {fmtDay(date)}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Stack spacing={0.25}>
            {rows.map((row, k) =>
              row.kind === 'gap' ? (
                <Typography key={`gap-${k}`} variant="caption" color="text.disabled" sx={{ pl: 1 }}>
                  {fmtTime(row.from)} – {fmtTime(row.to)} off the clock
                </Typography>
              ) : (
                <Box
                  key={row.s.id}
                  component="button"
                  type="button"
                  onClick={() => {
                    setNote('')
                    setCurrentId(row.s.id)
                  }}
                  sx={{
                    all: 'unset',
                    cursor: 'pointer',
                    display: 'flex',
                    gap: 1,
                    px: 1,
                    py: 0.75,
                    borderRadius: 1,
                    bgcolor: row.s.id === seg.id ? 'action.selected' : undefined,
                    '&:hover': { bgcolor: 'action.hover' },
                  }}
                >
                  <Typography variant="body2" sx={{ width: 120, flexShrink: 0, fontVariantNumeric: 'tabular-nums', fontWeight: row.s.id === seg.id ? 700 : 400 }}>
                    {fmtTime(row.s.clockIn)} – {row.s.clockOut ? fmtTime(row.s.clockOut) : 'now'}
                  </Typography>
                  <Typography variant="body2" noWrap sx={{ flex: 1, minWidth: 0, fontWeight: row.s.id === seg.id ? 700 : 400 }}>
                    {row.s.phase?.short ?? '—'} · {row.s.job.name}
                  </Typography>
                </Box>
              ),
            )}
          </Stack>

          {note && <Alert severity="success">{note}</Alert>}

          <Box>
            <Typography variant="overline" color="text.secondary">
              Segment {i + 1} of {segments.length}
            </Typography>
            <Typography sx={{ fontWeight: 700 }}>{label(seg)}</Typography>
          </Box>
          <TextField label="Start" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} InputLabelProps={{ shrink: true }} />
          {openToday ? (
            <Typography variant="body2" color="text.secondary">
              You are still on the clock on this one. Use Clock out on the clock screen to end it.
            </Typography>
          ) : (
            <TextField
              label={seg.clockOut ? 'End' : 'End (never clocked out)'}
              type="datetime-local"
              value={clockOut}
              onChange={(e) => setClockOut(e.target.value)}
              InputLabelProps={{ shrink: true }}
            />
          )}
          {(joinedBefore || joinedAfter) && (
            <FormControlLabel
              control={<Checkbox checked={keepJoined} onChange={(e) => setKeepJoined(e.target.checked)} />}
              label={
                <Typography variant="body2">
                  Move the {joinedBefore && joinedAfter ? 'segments before and after' : joinedBefore ? 'segment before' : 'segment after'} with it (you switched straight over)
                </Typography>
              }
            />
          )}
          {touchesSwitch && !keepJoined && (
            <Typography variant="caption" color="warning.main">
              Unticked: moving this time {inChanged && clockIn > toLocalInput(seg.clockIn) ? 'later' : 'earlier'} leaves you off the clock in between, or runs into the other segment and is refused.
            </Typography>
          )}
          <TextField
            label="What happened? (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g. Got to the site at 7:45, switched late"
            inputProps={{ maxLength: 300 }}
          />
          <Typography variant="caption" color="text.secondary">
            Your fix counts right away. Your supervisor sees what it was before and why it changed.
          </Typography>
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button disabled={!prev || saving} onClick={() => (setNote(''), prev && setCurrentId(prev.id))}>
          ‹ Back
        </Button>
        <Button disabled={!next || saving} onClick={() => (setNote(''), next && setCurrentId(next.id))}>
          Next ›
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onClose} disabled={saving}>
          Done
        </Button>
        <Button variant="contained" disabled={saving || !reason.trim() || (!inChanged && !outChanged)} onClick={() => timeCheck.guard(clockIn, clockOut, (ci, co) => void save(ci, co))}>
          {saving ? 'Saving…' : next ? 'Save and next' : 'Save'}
        </Button>
      </DialogActions>
      {timeCheck.dialog}
    </Dialog>
  )
}
