import { useEffect, useState } from 'react'
import { Box, Button, Fade, SvgIcon, Typography, type SvgIconProps } from '@mui/material'
import { fetchServerBuild } from '../api'

// ─── "New version available" after the Dell updates ─────────────────────────
// Each build bakes its id into the page (__APP_BUILD__) and writes the same id
// to version.json (vite.config.ts). When the app is opened, and when someone
// comes back to it (a phone brings the open app back, or the window comes back
// into view), the page reads version.json. A different id means the server has
// new code, so a centred card offers Reload. There is no timer: Art (2026-11-03) wants
// the check when a user opens the app, not every few seconds. The card never
// reloads by itself, so nobody loses what they're typing.

const MIN_CHECK_GAP_MS = 60 * 1000

// Same glyph as MUI's SystemUpdateAlt icon (this app doesn't ship @mui/icons-material).
function SystemUpdateAltIcon(props: SvgIconProps) {
  return (
    <SvgIcon {...props}>
      <path d="M12 16.5l4-4h-3v-9h-2v9H8l4 4zm9-13h-6v1.99h6v14.03H3V5.49h6V3.5H3c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2v-14c0-1.1-.9-2-2-2z" />
    </SvgIcon>
  )
}

export function NewVersionBanner() {
  const [newVersion, setNewVersion] = useState(false)

  useEffect(() => {
    if (import.meta.env.DEV) return // Vite dev reloads by itself
    let lastCheck = 0
    let found = false
    const check = async () => {
      if (found || !navigator.onLine || Date.now() - lastCheck < MIN_CHECK_GAP_MS) return
      lastCheck = Date.now()
      const build = await fetchServerBuild()
      if (build && build !== __APP_BUILD__) {
        found = true
        setNewVersion(true)
      }
    }
    void check()
    const onVisible = () => { if (document.visibilityState === 'visible') void check() }
    // A phone browser restoring the page from its back/forward cache.
    const onPageShow = (e: PageTransitionEvent) => { if (e.persisted) void check() }
    // Clicking back into the browser window from another program. Switching
    // windows doesn't always change visibility (the window can stay partly
    // in view), so focus counts as coming back too.
    const onFocus = () => { void check() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)
    window.addEventListener('focus', onFocus)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
      window.removeEventListener('focus', onFocus)
    }
  }, [])

  // Same look in every AIC app (Art, 2026-11-05): centred near-black card,
  // big white text, solid yellow Reload button with dark text (about 13:1
  // contrast), same in light and dark themes. No backdrop, so the page
  // underneath stays clickable and nobody loses work.
  return (
    <Fade in={newVersion} unmountOnExit>
      <Box
        role="alertdialog"
        aria-live="assertive"
        aria-labelledby="update-prompt-title"
        sx={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: (t) => t.zIndex.snackbar,
          width: 'min(92vw, 520px)',
          bgcolor: '#111111',
          color: '#ffffff',
          border: '2px solid #FFD600',
          borderRadius: 3,
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          px: { xs: 3, sm: 4 },
          py: { xs: 3, sm: 3.5 },
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 2.5,
          textAlign: 'center',
        }}
      >
        <SystemUpdateAltIcon sx={{ fontSize: 44, color: '#FFD600' }} />
        <Typography
          id="update-prompt-title"
          sx={{ fontSize: { xs: 20, sm: 24 }, fontWeight: 700, lineHeight: 1.3, color: '#ffffff' }}
        >
          A new version of Logbook is ready
        </Typography>
        <Button
          variant="contained"
          size="large"
          autoFocus
          onClick={() => window.location.reload()}
          sx={{
            bgcolor: '#FFD600',
            color: '#111111',
            fontSize: { xs: 20, sm: 22 },
            fontWeight: 800,
            letterSpacing: 0.5,
            px: 6,
            py: 1.5,
            minWidth: { xs: '100%', sm: 240 },
            borderRadius: 2,
            boxShadow: 'none',
            '&:hover': { bgcolor: '#FFEA00', boxShadow: 'none' },
            '&:focus-visible': { outline: '3px solid #ffffff', outlineOffset: 3 },
          }}
        >
          Reload
        </Button>
      </Box>
    </Fade>
  )
}
