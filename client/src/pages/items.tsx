import { useEffect, useState } from 'react'
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
  Paper,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material'
import { api, errorText, fmtHours, fmtTime, KEEP_REASONS, type OpenItem, type TeamItem } from '../api'
import { MODE_INFO } from './modes'

// Open items: a service ticket (Service) or a task (Shop, Office, CAD) stays open
// while the person switches to other work, and is picked back up with Resume. At
// the end of the day each one is closed with what was done, or left open with a
// reason. Logbook spec: OPEN-ITEMS-AND-CAD.md in the project.

const itemWord = (i: { mode: string }) => (i.mode === 'service' ? 'ticket' : 'task')
const firstLine = (s: string) => s.split('\n').find((l) => l.trim()) ?? ''
const since = (iso: string) => {
  const d = new Date(iso)
  const today = new Date().toDateString() === d.toDateString()
  return today ? fmtTime(iso) : `${d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ${fmtTime(iso)}`
}

function ModeTag({ mode }: { mode: string }) {
  const info = MODE_INFO[mode as keyof typeof MODE_INFO]
  return <Chip size="small" label={info?.label ?? mode} sx={{ fontWeight: 700, color: '#fff', bgcolor: info?.color ?? 'grey.600', height: 20 }} />
}

/** "Your open items" on the clock screen, each with Resume. The one on the clock now is marked. */
export function OpenItemsCard({ items, busy, onResume }: { items: OpenItem[]; busy: boolean; onResume: (i: OpenItem) => void }) {
  if (!items.length) return null
  return (
    <Paper sx={{ p: 1.5 }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        Your open items ({items.length})
      </Typography>
      <Stack spacing={1}>
        {items.map((i) => (
          <Stack key={i.id} direction="row" spacing={1} alignItems="center">
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={0.75} alignItems="center">
                <ModeTag mode={i.mode} />
                <Typography variant="body2" sx={{ fontWeight: 700 }} noWrap>
                  {i.job.name}
                </Typography>
              </Stack>
              {i.notes && (
                <Typography variant="caption" color="text.secondary" component="div" noWrap>
                  {firstLine(i.notes)}
                </Typography>
              )}
              <Typography variant="caption" color="text.secondary" component="div">
                Open since {since(i.openedAt)} · {fmtHours(i.hours)}
                {i.waitingReason ? ` · ${i.waitingReason}` : ''}
              </Typography>
            </Box>
            {i.current ? (
              <Chip size="small" color="success" label="On now" />
            ) : (
              <Button size="small" variant="contained" disabled={busy} onClick={() => onResume(i)}>
                Resume
              </Button>
            )}
          </Stack>
        ))}
      </Stack>
    </Paper>
  )
}

export interface Decision {
  choice: 'close' | 'keep' | null
  text: string
}
const decided = (d: Decision | undefined) => Boolean(d?.choice && d.text.trim())

/** Close this item (what was done) or leave it open (why). */
export function DecisionBox({ item, value, onChange }: { item: { mode: string }; value: Decision; onChange: (d: Decision) => void }) {
  const word = itemWord(item)
  return (
    <Stack spacing={1}>
      <ToggleButtonGroup exclusive fullWidth size="small" value={value.choice} onChange={(_, v) => v && onChange({ choice: v, text: '' })}>
        <ToggleButton value="close">Close {word}</ToggleButton>
        <ToggleButton value="keep">Leave open</ToggleButton>
      </ToggleButtonGroup>
      {value.choice === 'close' && (
        <TextField
          size="small"
          label="What was done?"
          placeholder={item.mode === 'service' ? 'e.g. Replaced amp, tested OK' : 'e.g. Drawings sent for review'}
          value={value.text}
          onChange={(e) => onChange({ ...value, text: e.target.value })}
          inputProps={{ maxLength: 1000 }}
          autoFocus
        />
      )}
      {value.choice === 'keep' && (
        <>
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75}>
            {KEEP_REASONS.map((r) => (
              <Chip key={r} label={r} size="small" color={value.text === r ? 'primary' : 'default'} variant={value.text === r ? 'filled' : 'outlined'} onClick={() => onChange({ ...value, text: r })} />
            ))}
          </Stack>
          <TextField size="small" label="Why it stays open" value={value.text} onChange={(e) => onChange({ ...value, text: e.target.value })} inputProps={{ maxLength: 300 }} />
        </>
      )}
    </Stack>
  )
}

/** Apply a close / leave-open decision. Nothing happens when none was made. */
export async function applyDecision(item: OpenItem, d: Decision): Promise<boolean> {
  if (!decided(d)) return false
  if (d.choice === 'close') await api.closeItem(item.id, d.text.trim())
  else await api.keepItem(item.id, d.text.trim())
  return true
}

/**
 * Clocking out with items still open: a break keeps them as they are; done for the
 * day asks, for each, to close it with what was done or leave it open with a reason.
 */
export function CloseOutDialog({
  open,
  items,
  alreadyLeft = [],
  onCancel,
  onBreak,
  onDone,
}: {
  open: boolean
  items: OpenItem[]
  /** Left open earlier with a reason: listed, not asked again. */
  alreadyLeft?: OpenItem[]
  onCancel: () => void
  onBreak: () => void
  onDone: () => void
}) {
  const [endOfDay, setEndOfDay] = useState(false)
  const [decisions, setDecisions] = useState<Record<string, Decision>>({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setEndOfDay(false)
      setDecisions({})
      setError('')
    }
  }, [open])

  const allDecided = items.every((i) => decided(decisions[i.id]))
  const finish = async () => {
    setSaving(true)
    setError('')
    try {
      for (const i of items) await applyDecision(i, decisions[i.id])
      onDone()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setSaving(false)
    }
  }

  const tickets = items.filter((i) => i.mode === 'service').length
  const tasks = items.length - tickets
  const what = [tickets ? `${tickets} service ticket${tickets === 1 ? '' : 's'}` : '', tasks ? `${tasks} task${tasks === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ')

  return (
    <Dialog open={open} onClose={saving ? undefined : onCancel} fullWidth maxWidth="sm">
      <DialogTitle>{endOfDay ? 'Close out your open items' : `You have ${what} open`}</DialogTitle>
      <DialogContent dividers>
        {!endOfDay ? (
          <Stack spacing={1.5}>
            <Typography variant="body2" color="text.secondary">
              A break keeps them open to pick back up. At the end of the day, close each one or say why it stays open.
            </Typography>
            <Button size="large" variant="outlined" onClick={onBreak}>
              Taking a break · clock out
            </Button>
            <Button size="large" variant="contained" onClick={() => setEndOfDay(true)}>
              Done for the day
            </Button>
          </Stack>
        ) : (
          <Stack spacing={2.5}>
            {items.map((i) => (
              <Box key={i.id}>
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 0.5 }}>
                  <ModeTag mode={i.mode} />
                  <Typography sx={{ fontWeight: 700 }}>{i.job.name}</Typography>
                </Stack>
                <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 1 }}>
                  {i.notes ? `${firstLine(i.notes)} · ` : ''}
                  {fmtHours(i.hours)} since {since(i.openedAt)}
                </Typography>
                <DecisionBox item={i} value={decisions[i.id] ?? { choice: null, text: '' }} onChange={(d) => setDecisions({ ...decisions, [i.id]: d })} />
              </Box>
            ))}
            {alreadyLeft.length > 0 && (
              <Typography variant="caption" color="text.secondary">
                Already left open, not asked again: {alreadyLeft.map((i) => `${i.job.name} (${i.waitingReason})`).join(' · ')}
              </Typography>
            )}
            {error && <Alert severity="error">{error}</Alert>}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        {endOfDay && (
          <Button variant="contained" color="warning" disabled={saving || !allDecided} onClick={() => void finish()}>
            {saving ? 'Saving…' : 'Clock out'}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}

/** The office's view: everyone's open tickets and tasks, oldest first. */
export function TeamOpenItems() {
  const [items, setItems] = useState<TeamItem[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api.teamItems().then(setItems, (err) => setError(errorText(err)))
  }, [])
  if (error) return <Alert severity="warning">Open items could not be loaded: {error}</Alert>
  if (!items) return <CircularProgress size={20} />
  if (!items.length) return null
  return (
    <Stack spacing={1}>
      <Typography variant="subtitle2">Open service tickets and tasks ({items.length})</Typography>
      {items.map((i) => (
        <Paper key={i.id} variant="outlined" sx={{ p: 1.25 }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <ModeTag mode={i.mode} />
            <Typography variant="body2" sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
              {i.job.name}
            </Typography>
            {i.onNow && <Chip size="small" color="success" label="On now" />}
          </Stack>
          <Typography variant="caption" color="text.secondary" component="div">
            {i.person.name} · open since {since(i.openedAt)} · {fmtHours(i.hours)}
            {i.waitingReason ? ` · left open: ${i.waitingReason}` : ''}
          </Typography>
          {i.notes && (
            <Typography variant="caption" component="div">
              {firstLine(i.notes)}
            </Typography>
          )}
        </Paper>
      ))}
    </Stack>
  )
}
