import { useState, type FormEvent } from 'react'
import { Alert, Box, Button, Paper, Stack, Typography } from '@mui/material'
import { api, errorText } from '../api'
import PasswordField from '../PasswordField'

// Opened from the "Forgot password?" email: /reset-password#token=… (the token rides in
// the address fragment, so it never reaches a server log). Looks like FirstPassword:
// same rules (at least 10 characters), eye button and password generator.
export default function ResetPassword({ token, onDone }: { token: string; onDone: (message?: string) => void }) {
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const problem =
    next.length > 0 && next.length < 10 ? 'At least 10 characters.' : again.length > 0 && again !== next ? 'The two new passwords do not match.' : ''
  const ready = Boolean(token) && next.length >= 10 && next === again && !busy

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      await api.resetPassword(token, next)
      onDone('Your new password is saved. Sign in with it.')
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'primary.main' }}>
      <Paper sx={{ p: 3, width: '100%', maxWidth: 420 }}>
        <form onSubmit={submit}>
          <Stack spacing={2}>
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                Choose a new password
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Pick a new Logbook password. This link works once.
              </Typography>
            </Box>
            {!token && <Alert severity="error">This link is not complete. Ask for a new one from the sign-in page.</Alert>}
            <PasswordField
              label="New password"
              autoComplete="new-password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              onGenerate={(pw) => {
                setNext(pw)
                setAgain(pw)
              }}
              helperText="At least 10 characters. Save a generated one in your password manager first"
              required
              autoFocus
            />
            <PasswordField label="New password again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
            {(problem || error) && <Alert severity={error ? 'error' : 'warning'}>{error || problem}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={!ready}>
              {busy ? 'Saving…' : 'Save new password'}
            </Button>
            <Button color="inherit" onClick={() => onDone()}>
              Back to sign in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Box>
  )
}
