import { useEffect, useState } from 'react'
import { Button, Snackbar } from '@mui/material'
import { fetchServerBuild } from '../api'

// ─── "New version available" after the Dell updates ─────────────────────────
// Each build bakes its id into the page (__APP_BUILD__) and writes the same id
// to version.json (vite.config.ts). When the app is opened, and when someone
// comes back to it (a phone brings the open app back, or the window comes back
// into view), the page reads version.json. A different id means the server has
// new code, so a bar offers Reload. There is no timer: Art (2026-11-03) wants
// the check when a user opens the app, not every few seconds. The bar never
// reloads by itself, so nobody loses what they're typing.

const MIN_CHECK_GAP_MS = 60 * 1000

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
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  return (
    <Snackbar
      open={newVersion}
      anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      message="New version available"
      action={
        <Button color="secondary" size="small" variant="contained" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    />
  )
}
