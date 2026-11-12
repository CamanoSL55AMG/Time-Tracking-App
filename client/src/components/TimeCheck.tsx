import { useState, type ReactNode } from 'react'
import { Button, Dialog, Stack, Typography } from '@mui/material'
import { checkTimes, type TimeWarning } from '../timeCheck'

// The "did you mean AM?" pop-up in front of any typed time (Art, 2026-11-12).
// Same look as the Reload card in every AIC app: near-black card, yellow border,
// solid yellow main button with dark text.

const YELLOW = '#FFD600'

type Proceed = (clockIn: string, clockOut: string) => void

/**
 * `guard(clockIn, clockOut, proceed)` saves straight away when the times look normal,
 * and otherwise asks first. `proceed` gets the times to save: the switched ones, or
 * the ones as entered. Render `dialog` somewhere in the component.
 */
export function useTimeCheck(): { guard: (clockIn: string, clockOut: string, proceed: Proceed) => void; dialog: ReactNode } {
  const [pending, setPending] = useState<{ warning: TimeWarning; clockIn: string; clockOut: string; proceed: Proceed } | null>(null)

  const guard = (clockIn: string, clockOut: string, proceed: Proceed) => {
    const warning = checkTimes(clockIn, clockOut)
    if (!warning) return proceed(clockIn, clockOut)
    setPending({ warning, clockIn, clockOut, proceed })
  }

  const dialog = pending ? (
    <TimeCheckDialog
      warning={pending.warning}
      onSwitch={() => {
        const { fix } = pending.warning
        setPending(null)
        if (fix) pending.proceed(fix.clockIn, fix.clockOut)
      }}
      onKeep={() => {
        setPending(null)
        pending.proceed(pending.clockIn, pending.clockOut)
      }}
      onBack={() => setPending(null)}
    />
  ) : null

  return { guard, dialog }
}

export function TimeCheckDialog({ warning, onSwitch, onKeep, onBack }: { warning: TimeWarning; onSwitch: () => void; onKeep: () => void; onBack: () => void }) {
  return (
    <Dialog
      open
      onClose={onBack}
      fullWidth
      maxWidth="xs"
      aria-labelledby="time-check-title"
      PaperProps={{
        sx: {
          bgcolor: '#111111',
          color: '#ffffff',
          backgroundImage: 'none',
          border: `2px solid ${YELLOW}`,
          borderRadius: 3,
          boxShadow: '0 12px 40px rgba(0,0,0,0.55)',
          px: { xs: 2.5, sm: 3.5 },
          py: { xs: 2.5, sm: 3 },
        },
      }}
    >
      <Stack spacing={2} alignItems="center" sx={{ textAlign: 'center' }}>
        <Typography id="time-check-title" sx={{ fontSize: { xs: 22, sm: 24 }, fontWeight: 700, lineHeight: 1.3, color: '#ffffff' }}>
          {warning.title}
        </Typography>
        {warning.question && <Typography sx={{ fontSize: { xs: 19, sm: 20 }, fontWeight: 600, color: YELLOW }}>{warning.question}</Typography>}
        {warning.lines.map((l) => (
          <Typography key={l} sx={{ fontSize: 16, color: 'rgba(255,255,255,0.85)' }}>
            {l}
          </Typography>
        ))}
        <Stack spacing={1.25} sx={{ width: '100%', pt: 1 }}>
          {warning.fix && (
            <Button
              variant="contained"
              size="large"
              autoFocus
              onClick={onSwitch}
              sx={{
                bgcolor: YELLOW,
                color: '#111111',
                fontSize: 18,
                fontWeight: 800,
                py: 1.25,
                borderRadius: 2,
                boxShadow: 'none',
                textTransform: 'none',
                '&:hover': { bgcolor: '#FFEA00', boxShadow: 'none' },
                '&:focus-visible': { outline: '3px solid #ffffff', outlineOffset: 3 },
              }}
            >
              {warning.fix.label}
            </Button>
          )}
          <Button
            variant="outlined"
            size="large"
            autoFocus={!warning.fix}
            onClick={onKeep}
            sx={{
              color: '#ffffff',
              borderColor: 'rgba(255,255,255,0.6)',
              fontSize: 16,
              fontWeight: 700,
              py: 1,
              borderRadius: 2,
              textTransform: 'none',
              '&:hover': { borderColor: '#ffffff', bgcolor: 'rgba(255,255,255,0.08)' },
            }}
          >
            Keep as entered
          </Button>
          <Button onClick={onBack} sx={{ color: 'rgba(255,255,255,0.8)', fontSize: 15, textTransform: 'none' }}>
            Go back
          </Button>
        </Stack>
      </Stack>
    </Dialog>
  )
}
