import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Alert, Box, Button, Divider, Paper, Stack, TextField, Typography } from '@mui/material'
import { api, errorText, setToken, type Person } from '../api'

const GSI_SRC = 'https://accounts.google.com/gsi/client'

/** Load Google Identity Services once. */
function loadGsi(): Promise<void> {
  if (window.google?.accounts?.id) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SRC}"]`)
    const s = existing ?? document.createElement('script')
    s.addEventListener('load', () => resolve())
    s.addEventListener('error', () => reject(new Error('Could not load Google sign-in.')))
    if (!existing) {
      s.src = GSI_SRC
      s.async = true
      document.head.appendChild(s)
    }
  })
}

export default function Login({ notice, onSignedIn }: { notice?: string; onSignedIn: (p: Person) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(notice ?? '')
  const [busy, setBusy] = useState(false)
  const [googleClientId, setGoogleClientId] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState(false)
  const googleBox = useRef<HTMLDivElement>(null)
  // The parent passes a new function each render; keep the latest without re-drawing Google's button.
  const signedIn = useRef(onSignedIn)
  signedIn.current = onSignedIn

  // Google only allows its button on https pages and on localhost, so it is not
  // offered when the app is opened by a plain-http network address.
  const googleUsable = window.isSecureContext

  useEffect(() => {
    api
      .authConfig()
      .then((c) => {
        setGoogleClientId(googleUsable ? c.googleClientId : null)
        setDashboard(Boolean(c.dashboard))
      })
      .catch(() => setGoogleClientId(null))
  }, [googleUsable])

  useEffect(() => {
    if (!googleClientId || !googleBox.current) return
    let cancelled = false
    loadGsi()
      .then(() => {
        if (cancelled || !googleBox.current || !window.google) return
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          ux_mode: 'popup',
          callback: async ({ credential }) => {
            setBusy(true)
            setError('')
            try {
              const s = await api.google(credential)
              setToken(s.token)
              signedIn.current(s.person)
            } catch (err) {
              setError(errorText(err))
            } finally {
              setBusy(false)
            }
          },
        })
        window.google.accounts.id.renderButton(googleBox.current, { theme: 'outline', size: 'large', text: 'signin_with', width: 316 })
      })
      .catch((err) => setError(errorText(err)))
    return () => {
      cancelled = true
    }
  }, [googleClientId])

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
            {dashboard && (
              <>
                {/* One sign-in for the Dashboard and every add-on (GED's DASHBOARD-SIGN-IN.md) */}
                <Button variant="contained" size="large" href="/api/v1/auth/dashboard/start" sx={{ py: 1.25 }}>
                  Sign in with Dashboard
                </Button>
                <Divider>
                  <Typography variant="caption" color="text.secondary">
                    {googleClientId ? 'or' : 'or with a password'}
                  </Typography>
                </Divider>
              </>
            )}
            {googleClientId && (
              <>
                <Box ref={googleBox} sx={{ display: 'flex', justifyContent: 'center', minHeight: 44 }} />
                <Divider>
                  <Typography variant="caption" color="text.secondary">
                    or with a password
                  </Typography>
                </Divider>
              </>
            )}
            <TextField label="Email" type="email" autoComplete="username" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus={!googleClientId} />
            <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            {error && <Alert severity="error">{error}</Alert>}
            <Button type="submit" variant={dashboard ? 'outlined' : 'contained'} size="large" disabled={busy || !email || !password}>
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
          </Stack>
        </form>
      </Paper>
    </Box>
  )
}
