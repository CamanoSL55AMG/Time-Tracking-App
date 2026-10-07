import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, CircularProgress, Paper, Stack, Typography } from '@mui/material'
import { api, errorText, fmtElapsed, fmtTime, type Board } from '../api'

// Tower board: who is on the clock, on which job, in which phase, since when.

export default function BoardPage() {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => new Date())

  const load = useCallback(async () => {
    try {
      setBoard(await api.board())
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
    setNow(new Date())
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  if (!board) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
        {error && <Button onClick={() => void load()}>Try again</Button>}
      </Stack>
    )
  }

  const on = board.rows.filter((r) => r.onClock)
  const off = board.rows.filter((r) => !r.onClock)

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip color="success" label={`${on.length} on the clock`} sx={{ fontWeight: 700 }} />
        <Chip variant="outlined" label={`${off.length} done for now`} />
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          as of {fmtTime(board.asOf)}
        </Typography>
      </Stack>
      {error && <Alert severity="warning">{error}</Alert>}
      {board.rows.length === 0 && <Typography color="text.secondary">Nobody has punched today.</Typography>}

      {board.rows.map((r) => (
        <Paper key={r.personId} sx={{ p: 1.75, opacity: r.onClock ? 1 : 0.65 }}>
          <Stack direction="row" spacing={1.5} alignItems="flex-start">
            <Box sx={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, mt: 0.9, bgcolor: r.onClock ? 'success.main' : 'text.disabled' }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Typography sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
                  {r.name}
                </Typography>
                {r.phaseName && (
                  <Chip
                    size="small"
                    color={r.onClock ? 'secondary' : 'default'}
                    variant={r.onClock ? 'filled' : 'outlined'}
                    label={r.phaseIndex !== null ? `${r.phaseIndex + 1}/${board.phaseCount} ${r.phaseName}` : r.phaseName}
                    sx={{ maxWidth: '60%', flexShrink: 0 }}
                  />
                )}
              </Stack>
              <Typography variant="body2" color="text.secondary" noWrap>
                {[r.jobName || '—', r.atShop === true ? 'at the shop' : r.atShop === false ? 'away from the shop' : ''].filter(Boolean).join(' · ')}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {r.onClock ? `since ${fmtTime(r.since)} · ${fmtElapsed(r.since, now)}` : `out ${fmtTime(r.lastOut)}`} · {r.hoursToday.toFixed(1)} h today
              </Typography>
            </Box>
          </Stack>
        </Paper>
      ))}
    </Stack>
  )
}
