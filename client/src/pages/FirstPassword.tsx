import { useState, type FormEvent } from 'react'
import { Alert, Box, Button, Stack, TextField, Typography } from '@mui/material'
import { api, errorText, type Person } from '../api'
import PasswordField from '../PasswordField'
import { SignInShell } from '../BrandBar'

// Shown instead of the app while the person must change a password an admin set for
// them (first sign-in, or after an admin set a new one). The server holds back every
// other call until this is done (server/src/auth/passwordChange.ts).
export default function FirstPassword({ person, onDone, onSignOut }: { person: Person; onDone: (p: Person) => void; onSignOut: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const problem =
    next.length > 0 && next.length < 10
      ? 'At least 10 characters.'
      : again.length > 0 && again !== next
        ? 'The two new passwords do not match.'
        : next.length > 0 && next === current
          ? 'Pick a password different from the one you were given.'
          : ''
  const ready = next.length >= 10 && next === again && next !== current && !busy

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!ready) return
    setBusy(true)
    setError('')
    try {
      await api.changePassword(current, next)
      const me = await api.me()
      if (me.person) onDone(me.person)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <SignInShell maxWidth={420}>
      <form onSubmit={submit}>
        <Stack spacing={2}>
          <Box>
            <Typography variant="h5" sx={{ fontWeight: 700 }}>
              Set your own password
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Hi {person.name}. You signed in with a password someone set for you. Pick your own before you go on.
            </Typography>
          </Box>
          {/* The browser's password manager saves the new one against this email. */}
          <TextField label="Email" value={person.email} autoComplete="username" slotProps={{ htmlInput: { readOnly: true } }} size="small" />
          <PasswordField label="Password you were given" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoFocus />
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
          />
          <PasswordField label="New password again" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
          {(problem || error) && <Alert severity={error ? 'error' : 'warning'}>{error || problem}</Alert>}
          <Button type="submit" variant="contained" size="large" disabled={!ready}>
            {busy ? 'Saving…' : 'Save and continue'}
          </Button>
          <Button color="inherit" onClick={onSignOut}>
            Sign out
          </Button>
        </Stack>
      </form>
    </SignInShell>
  )
}
