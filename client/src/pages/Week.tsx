import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, CircularProgress, Paper, Stack, Typography } from '@mui/material'
import { api, errorText, type PersonWeek } from '../api'
import WeekView, { StatusChips, WeekPicker } from '../components/WeekView'

// The tech's week: every segment, the total, and a button to sign it.

export default function WeekPage() {
  const [week, setWeek] = useState<string | undefined>(undefined)
  const [thisWeek, setThisWeek] = useState<string | undefined>(undefined)
  const [data, setData] = useState<PersonWeek | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (w?: string) => {
    try {
      const d = await api.myWeek(w)
      setData(d)
      setWeek(d.week)
      setThisWeek((t) => t ?? d.week)
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const sign = async () => {
    if (!data) return
    setBusy(true)
    try {
      await api.signWeek(data.week)
      await load(data.week)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!data || !week) {
    return (
      <Stack alignItems="center" sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
      </Stack>
    )
  }

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <WeekPicker week={week} maxWeek={thisWeek} onChange={(w) => void load(w)} />
        <StatusChips signedAt={data.signedAt} approvedAt={data.approvedAt} approvedBy={data.approvedBy} />
      </Stack>

      <Paper sx={{ p: 2 }}>
        <Stack direction="row" alignItems="center" spacing={2}>
          <Box sx={{ flex: 1 }}>
            <Typography variant="caption" color="text.secondary">
              Total this week
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
              {data.hours.toFixed(2)} h
            </Typography>
          </Box>
          {!data.approvedAt && (
            <Button variant="contained" size="large" onClick={sign} disabled={busy || data.onClock || Boolean(data.signedAt) || data.hours === 0}>
              {data.signedAt ? 'Signed' : 'Sign my week'}
            </Button>
          )}
        </Stack>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
          {data.approvedAt
            ? 'Approved. Ask a manager if anything here is wrong.'
            : data.onClock
              ? 'Clock out before signing.'
              : data.signedAt
                ? 'Signed. If anything changes, you will be asked to sign again.'
                : 'Signing says these hours are right. If something is wrong, tell a manager before you sign.'}
        </Typography>
      </Paper>

      {error && <Alert severity="error">{error}</Alert>}
      <WeekView data={data} />
    </Stack>
  )
}
