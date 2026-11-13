// TESTED & APPROVED by Art 2026-11-07: password field with generator. See TESTED.md before changing.
import { useState } from 'react'
import {
  Box,
  Button,
  Checkbox,
  Collapse,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Slider,
  Stack,
  SvgIcon,
  TextField,
  Typography,
  type TextFieldProps,
} from '@mui/material'
import {
  clampLength,
  copyText,
  DEFAULT_OPTIONS,
  generatePassword,
  loadOptions,
  MAX_LENGTH,
  MIN_LENGTH,
  saveOptions,
  type PasswordOptions,
} from './passwordGen'

type Props = Omit<TextFieldProps, 'type'> & {
  // Show Generate and Copy buttons under the box. Generate makes a strong random
  // password, hands it to onGenerate, and shows it in plain text so it can be read out.
  onGenerate?: (password: string) => void
}

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

// A password box with an eye button to show or hide what was typed.
export default function PasswordField({ onGenerate, ...props }: Props) {
  const [shown, setShown] = useState(false)
  const [copied, setCopied] = useState<'yes' | 'no' | null>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [opts, setOpts] = useState<PasswordOptions>(() => (onGenerate ? loadOptions() : DEFAULT_OPTIONS))
  const value = typeof props.value === 'string' ? props.value : ''

  const generate = (o: PasswordOptions = opts) => {
    if (!onGenerate) return
    setShown(true)
    setCopied(null)
    onGenerate(generatePassword(o))
  }
  // Changing an option remembers it and makes a new password with it, as the vault does.
  const setOpt = (o: PasswordOptions) => {
    const next = { ...o, length: clampLength(o.length) }
    setOpts(next)
    saveOptions(next)
    generate(next)
  }
  const copy = async () => {
    const ok = await copyText(value)
    setCopied(ok ? 'yes' : 'no')
    window.setTimeout(() => setCopied(null), 2500)
  }

  const field = (
    <TextField
      {...props}
      type={shown ? 'text' : 'password'}
      slotProps={{
        ...props.slotProps,
        htmlInput: { spellCheck: false, autoCapitalize: 'none', autoCorrect: 'off' },
        input: {
          sx: onGenerate && shown ? { fontFamily: MONO, letterSpacing: '0.04em' } : undefined,
          endAdornment: (
            <InputAdornment position="end">
              <IconButton
                aria-label={shown ? 'Hide password' : 'Show password'}
                title={shown ? 'Hide password' : 'Show password'}
                onClick={() => setShown((s) => !s)}
                onMouseDown={(e) => e.preventDefault()}
                edge="end"
              >
                <SvgIcon fontSize="small">
                  {shown ? (
                    <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7M2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2m4.31-.78 3.15 3.15.02-.16c0-1.66-1.34-3-3-3z" />
                  ) : (
                    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5M12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5m0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3" />
                  )}
                </SvgIcon>
              </IconButton>
            </InputAdornment>
          ),
        },
      }}
    />
  )

  if (!onGenerate) return field
  const toggle = (k: 'upper' | 'lower' | 'digits' | 'special' | 'avoidAmbiguous', label: string) => (
    <FormControlLabel
      sx={{ mr: 1.5 }}
      control={<Checkbox size="small" checked={opts[k]} onChange={(e) => setOpt({ ...opts, [k]: e.target.checked })} />}
      label={<Typography variant="body2">{label}</Typography>}
    />
  )
  return (
    <Box>
      {field}
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.75, flexWrap: 'wrap' }}>
        <Button size="small" variant="outlined" onClick={() => generate()}>
          {value ? 'Regenerate' : 'Generate password'}
        </Button>
        <Button size="small" onClick={() => void copy()} disabled={!value} color={copied === 'no' ? 'error' : 'primary'}>
          {copied === 'yes' ? 'Copied' : copied === 'no' ? 'Copy failed, select it by hand' : 'Copy'}
        </Button>
        <Button size="small" color="inherit" onClick={() => setOptionsOpen((o) => !o)} aria-expanded={optionsOpen}>
          Options {optionsOpen ? '▴' : '▾'}
        </Button>
      </Stack>
      <Collapse in={optionsOpen} unmountOnExit>
        <Box sx={{ mt: 1, p: 1.5, borderRadius: 1, border: 1, borderColor: 'divider' }}>
          <Stack direction="row" spacing={2} alignItems="center">
            <Typography variant="body2" sx={{ minWidth: 52 }}>
              Length
            </Typography>
            <Slider
              size="small"
              min={MIN_LENGTH}
              max={MAX_LENGTH}
              value={Number.isFinite(opts.length) ? opts.length : MIN_LENGTH}
              onChange={(_, v) => setOpts({ ...opts, length: v as number })}
              onChangeCommitted={(_, v) => setOpt({ ...opts, length: v as number })}
              aria-label="Password length"
            />
            <TextField
              size="small"
              type="number"
              value={Number.isFinite(opts.length) ? opts.length : ''}
              onChange={(e) => setOpts({ ...opts, length: Number(e.target.value) })}
              onBlur={() => setOpt({ ...opts, length: clampLength(opts.length) })}
              slotProps={{ htmlInput: { min: MIN_LENGTH, max: MAX_LENGTH, 'aria-label': 'Password length' } }}
              sx={{ width: 76, flexShrink: 0 }}
            />
          </Stack>
          <Box sx={{ mt: 0.5 }}>
            {toggle('upper', 'A-Z')}
            {toggle('lower', 'a-z')}
            {toggle('digits', '0-9')}
            {toggle('special', '!@#$%^&*')}
          </Box>
          {toggle('avoidAmbiguous', 'Avoid ambiguous characters (0 O o 1 I l)')}
        </Box>
      </Collapse>
    </Box>
  )
}
