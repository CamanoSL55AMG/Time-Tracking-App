import { Alert, Box, Button, Chip, IconButton, Paper, Stack, SvgIcon, Tooltip, Typography } from '@mui/material'
import { addDays, fmtDay, fmtTime, fmtWeek, type PersonWeek, type ReviewPunch } from '../api'

// One person's week, day by day. Read-only for the tech; a manager gets an edit
// button on each segment and an "add time" button on each day.

export const PrevIcon = () => (
  <SvgIcon>
    <path d="M15.4 7.4 14 6l-6 6 6 6 1.4-1.4L10.8 12z" />
  </SvgIcon>
)
export const NextIcon = () => (
  <SvgIcon>
    <path d="M8.6 16.6 10 18l6-6-6-6-1.4 1.4 4.6 4.6z" />
  </SvgIcon>
)
const EditIcon = () => (
  <SvgIcon fontSize="small">
    <path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75L3 17.25ZM20.7 7.04a1 1 0 0 0 0-1.41l-2.34-2.34a1 1 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83Z" />
  </SvgIcon>
)

export function WeekPicker({ week, onChange, maxWeek }: { week: string; onChange: (w: string) => void; maxWeek?: string }) {
  return (
    <Stack direction="row" alignItems="center" spacing={0.5}>
      <IconButton aria-label="Previous week" onClick={() => onChange(addDays(week, -7))}>
        <PrevIcon />
      </IconButton>
      <Typography sx={{ fontWeight: 700, minWidth: 128, textAlign: 'center' }}>{fmtWeek(week)}</Typography>
      <IconButton aria-label="Next week" disabled={Boolean(maxWeek && week >= maxWeek)} onClick={() => onChange(addDays(week, 7))}>
        <NextIcon />
      </IconButton>
    </Stack>
  )
}

export function StatusChips({ signedAt, approvedAt, approvedBy, onClock }: { signedAt: string | null; approvedAt: string | null; approvedBy?: string; onClock?: boolean }) {
  return (
    <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap>
      {onClock && <Chip size="small" color="secondary" label="On the clock" />}
      {approvedAt ? (
        <Chip size="small" color="success" label={approvedBy ? `Approved by ${approvedBy}` : 'Approved'} />
      ) : signedAt ? (
        <Chip size="small" color="primary" variant="outlined" label="Signed" />
      ) : (
        <Chip size="small" variant="outlined" label="Not signed" />
      )}
    </Stack>
  )
}

const hoursOf = (p: ReviewPunch, now: Date) => Math.max(0, ((p.clockOut ? new Date(p.clockOut) : now).getTime() - new Date(p.clockIn).getTime()) / 3_600_000)

export default function WeekView({
  data,
  onEdit,
  onAdd,
}: {
  data: PersonWeek
  onEdit?: (p: ReviewPunch) => void
  onAdd?: (date: string) => void
}) {
  const now = new Date()
  const days = data.days.filter((d) => d.punches.length || d.exceptions.length || onAdd)
  return (
    <Stack spacing={1.25}>
      {days.length === 0 && <Typography color="text.secondary">No time this week.</Typography>}
      {days.map((d) => (
        <Paper key={d.date} sx={{ p: 1.5 }}>
          <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: d.punches.length ? 0.75 : 0 }}>
            <Typography sx={{ fontWeight: 700, flex: 1 }}>{fmtDay(d.date)}</Typography>
            <Typography sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{d.hours ? `${d.hours.toFixed(2)} h` : '—'}</Typography>
            {onAdd && !data.approvedAt && (
              <Button size="small" onClick={() => onAdd(d.date)}>
                Add time
              </Button>
            )}
          </Stack>
          {d.punches.map((p) => (
            <Stack key={p.id} direction="row" alignItems="center" spacing={1} sx={{ py: 0.4, borderTop: '1px solid', borderColor: 'divider' }}>
              <Typography variant="body2" sx={{ width: 132, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                {fmtTime(p.clockIn)} – {p.clockOut ? fmtTime(p.clockOut) : 'now'}
              </Typography>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" noWrap>
                  {p.job.name}
                </Typography>
                <Typography variant="caption" color="text.secondary" noWrap component="div">
                  {[p.phase?.name, p.source === 'lead' ? 'crew punch' : p.source === 'edit' ? 'added later' : '', p.edits.length ? `changed ${p.edits.length}×` : '', p.notes]
                    .filter(Boolean)
                    .join(' · ')}
                </Typography>
              </Box>
              <Typography variant="body2" sx={{ fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {hoursOf(p, now).toFixed(2)}
              </Typography>
              {onEdit && !data.approvedAt && (
                <Tooltip title="Correct this segment">
                  <IconButton size="small" aria-label="Correct this segment" onClick={() => onEdit(p)}>
                    <EditIcon />
                  </IconButton>
                </Tooltip>
              )}
            </Stack>
          ))}
          {d.exceptions.length > 0 && (
            <Stack spacing={0.5} sx={{ mt: 0.75 }}>
              {d.exceptions.map((e, i) => (
                <Alert key={i} severity={e.severity === 'warn' ? 'warning' : 'info'} sx={{ py: 0, '& .MuiAlert-message': { py: 0.75 } }}>
                  {e.message}
                </Alert>
              ))}
            </Stack>
          )}
        </Paper>
      ))}
    </Stack>
  )
}
