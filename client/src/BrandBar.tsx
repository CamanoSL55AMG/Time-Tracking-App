import type { ReactNode } from 'react'
import { AppBar, Box, Paper, Toolbar } from '@mui/material'

/**
 * The top bar: the same header as AIC Accounting (Art, 2026-11-09) with the standard
 * AICPNW logo: the company name, Advanced Integration Consultants, under the chrome
 * logo (Art, 2026-11-10), then a divider, LOGBOOK, a divider and the company. Phones
 * keep Logbook under the logo. Used signed in (App.tsx, with the name menu as
 * children) and on every signed-out screen (SignInShell), so the two stay identical.
 */
export default function BrandBar({ companyName, children }: { companyName?: string | null; children?: ReactNode }) {
  return (
    <AppBar position="sticky" color="primary" elevation={0} sx={{ background: 'linear-gradient(90deg, #0f2537 0%, #173550 60%, #1d5a6e 100%)', boxShadow: '0 1px 0 rgba(0,0,0,.2)' }}>
      <Toolbar sx={{ gap: 1, minHeight: { xs: 54, sm: 54 } }}>
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', gap: '14px', minWidth: 0 }}>
          <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: '3px', flexShrink: 0 }}>
            <Box component="img" src="/brand/aicpnw-logo.png" alt="AICPNW" sx={{ height: { xs: 20, sm: 24 }, width: 'auto', display: 'block' }} />
            <Box component="span" sx={{ display: { xs: 'none', md: 'block' }, fontSize: 9, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase', color: '#cdd7e6', lineHeight: 1, whiteSpace: 'nowrap' }}>
              Advanced Integration Consultants
            </Box>
            <Box component="span" sx={{ display: { xs: 'block', md: 'none' }, fontSize: { xs: 10, sm: 11 }, fontWeight: 600, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#c9d1d7', lineHeight: 1, whiteSpace: 'nowrap' }}>
              Logbook
            </Box>
          </Box>
          <Box component="span" sx={{ display: { xs: 'none', md: 'inline' }, flexShrink: 0, fontSize: 12, fontWeight: 700, letterSpacing: '0.16em', textTransform: 'uppercase', color: '#e6ecf2', pl: '14px', borderLeft: '1px solid rgba(255,255,255,.22)', lineHeight: '24px', whiteSpace: 'nowrap' }}>
            Logbook
          </Box>
          {companyName && (
            <Box component="span" sx={{ display: { xs: 'none', sm: 'inline' }, fontSize: 14, opacity: 0.7, pl: '14px', borderLeft: '1px solid rgba(255,255,255,.22)', lineHeight: '24px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>
              {companyName}
            </Box>
          )}
        </Box>
        {children}
      </Toolbar>
    </AppBar>
  )
}

/**
 * A signed-out screen (sign in, forgot password, choose a new password, set your own
 * password): the top bar with no name menu (nobody is signed in, and the company is not
 * known yet), then the white card centred on the page background, with the slate key
 * sign-in icon at the top of the card.
 */
export function SignInShell({ maxWidth, children }: { maxWidth: number; children: ReactNode }) {
  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <BrandBar />
      <Box sx={{ flex: 1, display: 'grid', placeItems: 'center', p: 2 }}>
        <Paper sx={{ p: 3, width: '100%', maxWidth, bgcolor: '#fff' }}>
          <Box component="img" src="/brand/sign-in-key.png" alt="AIC sign-in" sx={{ width: 64, height: 64, borderRadius: '14px', display: 'block', mx: 'auto', mb: 2 }} />
          {children}
        </Paper>
      </Box>
    </Box>
  )
}
