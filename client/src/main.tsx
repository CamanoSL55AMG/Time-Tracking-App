import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { CssBaseline, ThemeProvider, createTheme } from '@mui/material'
import '@fontsource/inter/400.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import App from './App'

const theme = createTheme({
  palette: {
    primary: { main: '#14213d' },
    secondary: { main: '#fca311', contrastText: '#14213d' },
    success: { main: '#1f8a4c' },
    warning: { main: '#c2410c' },
    background: { default: '#f4f5f7' },
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif',
    button: { textTransform: 'none', fontWeight: 700 },
  },
  components: {
    // Tooltips open ABOVE the control: the mouse pointer hangs down from its
    // tip, so a tooltip below the control gets hidden under the hand cursor.
    // Near the top of the window (no room above) they move to the side, and
    // only go below as a last resort. They never block clicks.
    MuiTooltip: {
      defaultProps: {
        placement: 'top',
        enterDelay: 700,
        enterNextDelay: 500,
        leaveDelay: 0,
        disableInteractive: true,
        slotProps: {
          popper: {
            modifiers: [
              { name: 'offset', options: { offset: [0, 10] } },
              { name: 'flip', options: { fallbackPlacements: ['right', 'left', 'bottom'] } },
            ],
          },
        },
      },
    },
    MuiButton: { defaultProps: { disableElevation: true } },
    MuiPaper: { defaultProps: { elevation: 0 }, styleOverrides: { root: { border: '1px solid #e2e5ea' } } },
  },
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
)
