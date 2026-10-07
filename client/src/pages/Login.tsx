import { useState, type FormEvent } from 'react'
import { Alert, Box, Button, Paper, Stack, TextField, Typography } from '@mui/material'
import { api, errorText, setToken, type Person } from '../api'

export default function Login({ notice, onSignedIn }: { notice?: string; onSignedIn: (p: Person) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(notice ?? '')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const s = await api.login(email.trim(), password)
      setToken(s.token)
      onSignedIn(s.person)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', p: 2, bgcolor: 'primary.main' }}>
      <Paper sx={{ p: 3, width: '100%', maxWidth: 380 }}>
        <form onSubmit={submit}>
          <Stack spacing={2}>
            <Box>
              <Typography variant="h5" sx={{ fontWeight: 700 }}>
                Time Tracking
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Sign in to clock in.
              </Typography>
            </Box>
            <TextField label="Email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant="contained" size="large" disabled={busy || !email || !password}>
              Sign in
            </Button>
          </Stack>
        </form>
      </Paper>
    </Box>
  )
}
