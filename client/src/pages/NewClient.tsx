import { useEffect, useState } from 'react'
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material'
import { api, errorText, type Job, type NewClient } from '../api'

// A tech adds a client that is not in the list yet, for a Service Call or a Site
// Visit (Art, 2026-11-02). Client name, address, a contact person, phone and email
// are the minimum. The new item is then picked, so the next tap (Start drive /
// Switch) moves the clock onto it. The office checks it under Manage > Jobs.

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
const digits = (s: string) => s.replace(/\D/g, '')

const EMPTY: NewClient = { kind: 'service', clientName: '', siteAddress: '', contactName: '', contactPhone: '', contactEmail: '', note: '' }

export function NewClientDialog({
  open,
  defaultKind = 'service',
  onClose,
  onAdded,
}: {
  open: boolean
  defaultKind?: NewClient['kind']
  onClose: () => void
  onAdded: (job: Job, existed: boolean) => void
}) {
  const [f, setF] = useState<NewClient>({ ...EMPTY, kind: defaultKind })
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setF({ ...EMPTY, kind: defaultKind })
      setTried(false)
      setError('')
    }
  }, [open, defaultKind])

  const set = (k: keyof NewClient) => (e: React.ChangeEvent<HTMLInputElement>) => setF((v) => ({ ...v, [k]: e.target.value }))
  const problems: Partial<Record<keyof NewClient, string>> = {
    clientName: f.clientName.trim() ? '' : 'Client name is needed',
    siteAddress: f.siteAddress.trim() ? '' : 'Address is needed',
    contactName: f.contactName.trim() ? '' : 'Contact person is needed',
    contactPhone: !f.contactPhone.trim() ? 'Phone is needed' : digits(f.contactPhone).length < 10 ? 'Include the area code' : '',
    contactEmail: !f.contactEmail.trim() ? 'Email is needed' : EMAIL.test(f.contactEmail.trim()) ? '' : 'Check the email address',
  }
  const ok = Object.values(problems).every((p) => !p)
  const err = (k: keyof NewClient) => (tried && problems[k] ? problems[k] : undefined)

  const save = async () => {
    setTried(true)
    if (!ok) return
    setBusy(true)
    setError('')
    try {
      const r = await api.addClient({ ...f, note: f.note?.trim() || undefined })
      onAdded(r.job, !r.created)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} fullWidth maxWidth="xs">
      <DialogTitle>Add a new client</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={1.75}>
          <ToggleButtonGroup exclusive fullWidth color="primary" value={f.kind} onChange={(_, v) => v && setF((x) => ({ ...x, kind: v }))}>
            <ToggleButton value="service">Service Call</ToggleButton>
            <ToggleButton value="visit">Site Visit</ToggleButton>
          </ToggleButtonGroup>
          <Typography variant="caption" color="text.secondary">
            {f.kind === 'service'
              ? 'Billed with the service-call rules: trip charge, then 15-minute steps.'
              : 'A pre-sale walk. The time is paid but never billed to the client.'}
          </Typography>
          <TextField label="Client name" required value={f.clientName} onChange={set('clientName')} error={!!err('clientName')} helperText={err('clientName')} inputProps={{ maxLength: 200 }} autoFocus />
          <TextField
            label="Address"
            required
            value={f.siteAddress}
            onChange={set('siteAddress')}
            error={!!err('siteAddress')}
            helperText={err('siteAddress') ?? 'Street, city'}
            inputProps={{ maxLength: 300 }}
          />
          <TextField label="Contact person" required value={f.contactName} onChange={set('contactName')} error={!!err('contactName')} helperText={err('contactName')} inputProps={{ maxLength: 200 }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.75}>
            <TextField label="Phone" required type="tel" value={f.contactPhone} onChange={set('contactPhone')} error={!!err('contactPhone')} helperText={err('contactPhone')} inputProps={{ maxLength: 40 }} fullWidth />
            <TextField label="Email" required type="email" value={f.contactEmail} onChange={set('contactEmail')} error={!!err('contactEmail')} helperText={err('contactEmail')} inputProps={{ maxLength: 200 }} fullWidth />
          </Stack>
          <TextField label="What it is about (optional)" value={f.note} onChange={set('note')} multiline maxRows={3} inputProps={{ maxLength: 500 }} />
          {error && <Alert severity="error">{error}</Alert>}
          <Box>
            <Typography variant="caption" color="text.secondary">
              The office checks new clients before they go into Jetbuilt and AccountEdge.
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button variant="contained" onClick={() => void save()} disabled={busy}>
          {busy ? 'Adding…' : 'Add and pick it'}
        </Button>
      </DialogActions>
    </Dialog>
  )
}

/** Who to call at a client, with tap-to-call and tap-to-email. */
export function ContactLine({ job }: { job: Job | null | undefined }) {
  if (!job?.contactName && !job?.contactPhone) return null
  return (
    <Typography variant="body2" color="text.secondary">
      {job.contactName}
      {job.contactPhone && (
        <>
          {' · '}
          <Box component="a" href={`tel:${digits(job.contactPhone)}`} sx={{ color: 'primary.main', fontWeight: 600 }}>
            {job.contactPhone}
          </Box>
        </>
      )}
      {job.contactEmail && (
        <>
          {' · '}
          <Box component="a" href={`mailto:${job.contactEmail}`} sx={{ color: 'primary.main', fontWeight: 600 }}>
            Email
          </Box>
        </>
      )}
    </Typography>
  )
}
