import { useEffect, useState, type ReactNode } from 'react'
import { Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Paper, Stack, TextField, Typography } from '@mui/material'
import { api, errorText, fmtTime, toLocalInput, type ChangeRequest, type Job, type Phase, type RequestBody, type RequestStatus, type WeekSegment } from '../api'

// Asking for a change to your own time, and showing what was asked. Nothing changes
// until a supervisor approves; then it is applied as a correction with the reason.

const dayTime = (iso: string) =>
  `${new Date(iso).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(iso)}`

/** What the request would change, one line each. */
export function changeLines(r: ChangeRequest): string[] {
  const c = r.change
  if (r.kind === 'add') {
    return [`Add ${c.clockIn ? dayTime(c.clockIn) : '?'} – ${c.clockOut ? fmtTime(c.clockOut) : '?'} on ${c.jobName ?? '?'}${c.phaseName ? ` (${c.phaseName})` : ''}`]
  }
  const b = r.before
  const out: string[] = []
  if (b) out.push(`${dayTime(b.clockIn)} – ${b.clockOut ? fmtTime(b.clockOut) : 'open'} · ${b.phaseName ?? 'no phase'} · ${b.jobName}`)
  if (c.clockIn) out.push(`Start ${b ? fmtTime(b.clockIn) : ''} → ${fmtTime(c.clockIn)}`)
  if (c.clockOut) out.push(`End ${b?.clockOut ? fmtTime(b.clockOut) : 'open'} → ${fmtTime(c.clockOut)}`)
  if (c.jobId) out.push(`Job ${b?.jobName ?? ''} → ${c.jobName}`)
  if (c.phaseId) out.push(`Phase ${b?.phaseName ?? 'none'} → ${c.phaseName}`)
  if (c.notes !== null) out.push(`Note → "${c.notes}"`)
  return out
}

const statusChip: Record<RequestStatus, { label: string; color: 'default' | 'warning' | 'success' | 'error' }> = {
  pending: { label: 'Waiting for approval', color: 'warning' },
  approved: { label: 'Approved', color: 'success' },
  rejected: { label: 'Turned down', color: 'error' },
  withdrawn: { label: 'Withdrawn', color: 'default' },
}

export function RequestCard({ req, showName, actions }: { req: ChangeRequest; showName?: boolean; actions?: ReactNode }) {
  const s = statusChip[req.status]
  const lines = changeLines(req)
  return (
    <Paper variant="outlined" sx={{ p: 1.5 }}>
      <Stack spacing={0.5}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="body2" sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
            {showName ? req.person.name : req.kind === 'add' ? 'Missing time' : 'Change'}
          </Typography>
          <Chip size="small" color={s.color} label={s.label} />
        </Stack>
        {lines.map((l, i) => (
          <Typography key={i} variant="body2" color={i === 0 && req.kind === 'edit' ? 'text.secondary' : 'text.primary'}>
            {l}
          </Typography>
        ))}
        <Typography variant="caption" color="text.secondary">
          Why: {req.reason}
        </Typography>
        {req.status !== 'pending' && req.decidedBy && (
          <Typography variant="caption" color="text.secondary">
            {req.status === 'approved' ? 'Approved' : 'Turned down'} by {req.decidedBy}
            {req.decisionNote ? `: ${req.decisionNote}` : ''}
          </Typography>
        )}
        {actions}
      </Stack>
    </Paper>
  )
}

/** Ask for a change to one segment, or (no segment) for missing time on a day of the week. */
export function RequestDialog({ segment, day, onClose, onSent }: { segment?: WeekSegment | null; day?: string; onClose: () => void; onSent: (r: ChangeRequest) => void }) {
  const adding = !segment
  const [jobs, setJobs] = useState<Job[]>([])
  const [phases, setPhases] = useState<Phase[]>([])
  const [clockIn, setClockIn] = useState(segment ? toLocalInput(segment.clockIn) : day ? `${day}T07:00` : '')
  const [clockOut, setClockOut] = useState(segment ? toLocalInput(segment.clockOut) : day ? `${day}T15:30` : '')
  const [jobId, setJobId] = useState(segment?.job.id ?? '')
  const [phaseId, setPhaseId] = useState(segment?.phase?.id ?? '')
  const [notes, setNotes] = useState(segment?.notes ?? '')
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)

  useEffect(() => {
    Promise.all([api.jobs(), api.phases()]).then(
      ([j, p]) => {
        // Keep the segment's own job in the list even if it has since closed.
        const list = segment && !j.some((x) => x.id === segment.job.id) ? [{ ...segment.job, active: false } as Job, ...j] : j
        setJobs(list)
        setPhases(p)
      },
      (err) => setError(errorText(err)),
    )
  }, [segment])

  const send = async () => {
    setSending(true)
    setError('')
    try {
      const body: RequestBody = { reason }
      const iso = (v: string) => (v ? new Date(v).toISOString() : undefined)
      if (adding) {
        Object.assign(body, { clockIn: iso(clockIn), clockOut: iso(clockOut), jobId, phaseId: phaseId || undefined, notes: notes || undefined })
      } else {
        body.punchId = segment!.id
        if (clockIn !== toLocalInput(segment!.clockIn)) body.clockIn = iso(clockIn)
        if (clockOut && clockOut !== toLocalInput(segment!.clockOut)) body.clockOut = iso(clockOut)
        if (jobId !== segment!.job.id) body.jobId = jobId
        if (phaseId && phaseId !== (segment!.phase?.id ?? '')) body.phaseId = phaseId
        if (notes !== segment!.notes) body.notes = notes
      }
      onSent(await api.askChange(body))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSending(false)
    }
  }

  const ready = reason.trim() && (adding ? clockIn && clockOut && jobId : true)
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>{adding ? 'Add missing time' : 'Ask for a change'}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {adding
              ? 'For time you worked but never punched. Your supervisor approves it before it counts.'
              : `Now: ${fmtTime(segment!.clockIn)} – ${segment!.clockOut ? fmtTime(segment!.clockOut) : 'still open'} · ${segment!.phase?.name ?? 'no phase'} · ${segment!.job.name}. Change what is wrong; your supervisor approves it before it counts.`}
          </Typography>
          <TextField label="Start" type="datetime-local" value={clockIn} onChange={(e) => setClockIn(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField label="End" type="datetime-local" value={clockOut} onChange={(e) => setClockOut(e.target.value)} InputLabelProps={{ shrink: true }} />
          <TextField select label="Job" value={jobId} onChange={(e) => setJobId(e.target.value)}>
            {jobs.map((j) => (
              <MenuItem key={j.id} value={j.id}>
                {j.kind === 'project' && j.code && !j.name.includes(j.code) ? `${j.code} ${j.name}` : j.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField select label="Phase" value={phaseId} onChange={(e) => setPhaseId(e.target.value)}>
            {phases.map((p) => (
              <MenuItem key={p.id} value={p.id}>
                {p.name}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Note (optional)" value={notes} onChange={(e) => setNotes(e.target.value)} inputProps={{ maxLength: 300 }} />
          <TextField
            label="What happened? (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={adding ? 'e.g. Phone died, worked 7 to 3:30 at the site' : 'e.g. Forgot to clock out, left at 3:30'}
            inputProps={{ maxLength: 300 }}
          />
          {error && <Alert severity="error">{error}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={sending || !ready} onClick={send}>
          {sending ? 'Sending…' : 'Send for approval'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** The supervisor's decision on one request: approve, or turn down with a note. */
export function DecideButtons({ req, onDone }: { req: ChangeRequest; onDone: () => void }) {
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const decide = async (d: 'approve' | 'reject') => {
    setBusy(true)
    setError('')
    try {
      await api.decideRequest(req.id, d, note)
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Box sx={{ pt: 0.5 }}>
      {rejecting && (
        <TextField size="small" fullWidth autoFocus label="Why not? (they will see this)" value={note} onChange={(e) => setNote(e.target.value)} sx={{ mb: 1 }} inputProps={{ maxLength: 300 }} />
      )}
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        {rejecting ? (
          <>
            <Button size="small" onClick={() => setRejecting(false)} disabled={busy}>
              Cancel
            </Button>
            <Button size="small" color="error" variant="contained" disabled={busy || !note.trim()} onClick={() => decide('reject')}>
              Turn down
            </Button>
          </>
        ) : (
          <>
            <Button size="small" color="error" onClick={() => setRejecting(true)} disabled={busy}>
              Turn down
            </Button>
            <Button size="small" variant="contained" onClick={() => decide('approve')} disabled={busy}>
              {busy ? 'Approving…' : 'Approve'}
            </Button>
          </>
        )}
      </Stack>
      {error && (
        <Alert severity="error" sx={{ mt: 1 }}>
          {error}
        </Alert>
      )}
    </Box>
  )
}
