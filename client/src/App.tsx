import { useCallback, useEffect, useState } from 'react'
import {
  Alert,
  AppBar,
  BottomNavigation,
  BottomNavigationAction,
  Box,
  Button,
  CircularProgress,
  Container,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Menu,
  MenuItem,
  Paper,
  Stack,
  SvgIcon,
  TextField,
  Toolbar,
  Typography,
} from '@mui/material'
import { api, errorText, getToken, setSignedOutHandler, setToken, type Person } from './api'
import Login from './pages/Login'
import PunchPage from './pages/Punch'
import BoardPage from './pages/Board'
import AdminPage from './pages/Admin'
import WeekPage from './pages/Week'
import ReviewPage from './pages/Review'

type Tab = 'clock' | 'week' | 'board' | 'review' | 'admin'

const ClockIcon = () => (
  <SvgIcon>
    <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 18a8 8 0 1 1 0-16 8 8 0 0 1 0 16Zm.75-13h-1.5v6l5 3 .75-1.23-4.25-2.52V7Z" />
  </SvgIcon>
)
const BoardIcon = () => (
  <SvgIcon>
    <path d="M3 5h18v2H3V5Zm0 6h18v2H3v-2Zm0 6h18v2H3v-2Z" />
  </SvgIcon>
)
const WeekIcon = () => (
  <SvgIcon>
    <path d="M19 4h-1V2h-2v2H8V2H6v2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2Zm0 16H5V9h14v11ZM7 11h5v5H7v-5Z" />
  </SvgIcon>
)
const ReviewIcon = () => (
  <SvgIcon>
    <path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4L9 16.2Z" />
  </SvgIcon>
)
const AdminIcon = () => (
  <SvgIcon>
    <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-3.33 0-8 1.67-8 5v1h16v-1c0-3.33-4.67-5-8-5Z" />
  </SvgIcon>
)

export default function App() {
  const [person, setPerson] = useState<Person | null>(null)
  const [loading, setLoading] = useState(true)
  const [bootError, setBootError] = useState('')
  const [tab, setTab] = useState<Tab>('clock')
  const [menuAt, setMenuAt] = useState<HTMLElement | null>(null)
  const [pwOpen, setPwOpen] = useState(false)

  const signOut = useCallback(() => {
    setToken(null)
    setPerson(null)
    setMenuAt(null)
    setTab('clock')
  }, [])

  useEffect(() => {
    setSignedOutHandler(() => setPerson(null))
    const boot = async () => {
      // Arriving from GED with a one-click sign-in link: /sso?token=…
      const url = new URL(window.location.href)
      const sso = url.pathname === '/sso' ? url.searchParams.get('token') : null
      if (url.pathname === '/sso') window.history.replaceState(null, '', '/')
      try {
        if (sso) {
          const s = await api.sso(sso)
          setToken(s.token)
          setPerson(s.person)
        } else if (getToken()) {
          const me = await api.me()
          setPerson(me.person)
        }
      } catch (err) {
        if (sso) setBootError(errorText(err))
        else if (!getToken()) setPerson(null)
        else setBootError(errorText(err))
      } finally {
        setLoading(false)
      }
    }
    void boot()
  }, [])

  if (loading) {
    return (
      <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }
  if (!person) return <Login notice={bootError} onSignedIn={setPerson} />

  const can = (scope: string) => person.scopes.includes(scope)
  const showBoard = can('punch:read')
  const showAdmin = can('people:write') || can('jobs:write')
  const showReview = can('time:approve') || can('reports:read')
  const current: Tab = (tab === 'board' && !showBoard) || (tab === 'admin' && !showAdmin) || (tab === 'review' && !showReview) ? 'clock' : tab

  return (
    <Box sx={{ minHeight: '100dvh', pb: 'calc(72px + env(safe-area-inset-bottom))' }}>
      <AppBar position="sticky" color="primary" elevation={0}>
        <Toolbar sx={{ gap: 1 }}>
          <Typography variant="h6" sx={{ fontWeight: 700, flex: 1 }}>
            Time Tracking
          </Typography>
          <Button color="inherit" onClick={(e) => setMenuAt(e.currentTarget)} sx={{ fontWeight: 600 }}>
            {person.name}
          </Button>
          <Menu anchorEl={menuAt} open={Boolean(menuAt)} onClose={() => setMenuAt(null)}>
            <MenuItem disabled sx={{ opacity: '1 !important' }}>
              <Typography variant="body2" color="text.secondary">
                {person.email} · {person.role}
              </Typography>
            </MenuItem>
            <MenuItem
              onClick={() => {
                setMenuAt(null)
                setPwOpen(true)
              }}
            >
              Change password
            </MenuItem>
            <MenuItem onClick={signOut}>Sign out</MenuItem>
          </Menu>
        </Toolbar>
      </AppBar>

      <Container maxWidth={current === 'clock' || current === 'week' ? 'sm' : 'md'} sx={{ py: 2 }}>
        {current === 'clock' && <PunchPage />}
        {current === 'week' && <WeekPage />}
        {current === 'board' && <BoardPage canCrew={can('punch:crew')} />}
        {current === 'review' && <ReviewPage me={person} />}
        {current === 'admin' && <AdminPage me={person} />}
      </Container>

      <Paper square sx={{ position: 'fixed', bottom: 0, left: 0, right: 0, borderWidth: '1px 0 0', pb: 'env(safe-area-inset-bottom)', zIndex: 10 }}>
          <BottomNavigation showLabels value={current} onChange={(_, v: Tab) => setTab(v)} sx={{ '& .MuiBottomNavigationAction-root': { minWidth: 0, px: 0.5 } }}>
            <BottomNavigationAction value="clock" label="Clock" icon={<ClockIcon />} />
            <BottomNavigationAction value="week" label="Week" icon={<WeekIcon />} />
            {showBoard && <BottomNavigationAction value="board" label="Board" icon={<BoardIcon />} />}
            {showReview && <BottomNavigationAction value="review" label="Review" icon={<ReviewIcon />} />}
            {showAdmin && <BottomNavigationAction value="admin" label="Manage" icon={<AdminIcon />} />}
          </BottomNavigation>
      </Paper>

      <PasswordDialog open={pwOpen} onClose={() => setPwOpen(false)} />
    </Box>
  )
}

function PasswordDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [busy, setBusy] = useState(false)

  const close = () => {
    setCurrent('')
    setNext('')
    setError('')
    setDone(false)
    onClose()
  }
  const save = async () => {
    setBusy(true)
    setError('')
    try {
      await api.changePassword(current, next)
      setDone(true)
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={close} fullWidth maxWidth="xs">
      <DialogTitle>Change password</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          {done ? (
            <Alert severity="success">Password changed.</Alert>
          ) : (
            <>
              <TextField label="Current password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} helperText="Leave blank if you have never set one" />
              <TextField label="New password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} helperText="At least 10 characters" />
              {error && <Alert severity="error">{error}</Alert>}
            </>
          )}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={close}>{done ? 'Close' : 'Cancel'}</Button>
        {!done && (
          <Button variant="contained" onClick={save} disabled={busy || next.length < 10}>
            Save
          </Button>
        )}
      </DialogActions>
    </Dialog>
  )
}
