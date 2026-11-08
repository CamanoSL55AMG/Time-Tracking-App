import { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Button, List, ListItemButton, ListItemText, Paper, Stack, TextField, Typography } from '@mui/material'
import { api, type Job } from '../api'
import { searchJobs } from './jobMatch'

// Search-only job picker. Nothing is listed until something is typed; then the
// best matches by job number or name show right under the box, inside the form.
//
// Why not MUI Autocomplete: its list opens in a popup layered outside the dialog.
// On iPhone Safari, tapping an option there let the dialog take focus back first,
// so the popup closed before the tap counted and the job was never kept; tapping
// the box again just reopened the full list (Art, 2026-11-03). Results here are
// plain buttons in the dialog itself, and a pick is shown as a fixed line with
// Change, so there is nothing for focus to undo.

export type PickedJob = Pick<Job, 'id' | 'name' | 'code'> & { kind?: string; clientName?: string }

const KIND: Record<string, string> = {
  project: 'Project',
  service: 'Service call',
  visit: 'Site visit',
  shop: 'Shop',
  repair: 'Repair ticket',
  other: 'Office',
}

export const jobLabel = (j: { name: string; code: string; kind?: string }) =>
  j.code && !j.name.includes(j.code) && j.kind !== 'shop' ? `${j.code} ${j.name}` : j.name

/** The server returns at most this many jobs in one go; past it, search on the server too. */
const PAGE_MAX = 500

export function JobSearch({
  jobs,
  value,
  onChange,
  label = 'Job',
  autoFocus = false,
}: {
  jobs: Job[]
  value: PickedJob | null
  onChange: (j: Job | null) => void
  label?: string
  autoFocus?: boolean
}) {
  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<Job[]>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // A very large job list did not all come down; ask the server as well.
  useEffect(() => {
    const q = query.trim()
    if (jobs.length < PAGE_MAX || !q) {
      setRemote([])
      return
    }
    const t = window.setTimeout(() => {
      api.jobs(q).then((r) => setRemote(r.filter((x) => x.code !== 'OVERHEAD')), () => undefined)
    }, 250)
    return () => window.clearTimeout(t)
  }, [query, jobs.length])

  const results = useMemo(() => {
    const all = remote.length ? [...jobs, ...remote.filter((r) => !jobs.some((j) => j.id === r.id))] : jobs
    return searchJobs(all, query)
  }, [jobs, remote, query])

  // Keep the matches in sight above the phone keyboard when they first appear.
  const shown = results.length > 0
  useEffect(() => {
    if (shown) listRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [shown])

  if (value) {
    return (
      <Paper variant="outlined" sx={{ px: 1.5, py: 1, mt: 1 }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="caption" color="text.secondary" component="div">
              {label}
              {value.kind && KIND[value.kind] ? ` · ${KIND[value.kind]}` : ''}
            </Typography>
            <Typography variant="body2" sx={{ fontWeight: 600, overflowWrap: 'anywhere' }}>
              {jobLabel(value)}
            </Typography>
          </Box>
          <Button
            size="small"
            onClick={() => {
              onChange(null)
              setQuery('')
              // Straight back to typing; the box mounts on the next render.
              window.setTimeout(() => inputRef.current?.focus(), 0)
            }}
          >
            Change
          </Button>
        </Stack>
      </Paper>
    )
  }

  const typed = query.trim().length > 0
  return (
    <Box sx={{ mt: 1 }}>
      <TextField
        fullWidth
        label={label}
        placeholder="Type a job name or number"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && results[0]) {
            e.preventDefault()
            onChange(results[0])
          }
        }}
        inputRef={inputRef}
        autoFocus={autoFocus}
        autoComplete="off"
        inputProps={{ enterKeyHint: 'search', autoCapitalize: 'off', autoCorrect: 'off', spellCheck: false, 'aria-label': `${label} search` }}
        helperText={typed ? (results.length ? '' : 'No job matches. Try part of the name or the number.') : 'Type part of the job name or number.'}
      />
      {typed && results.length > 0 && (
        <Paper variant="outlined" ref={listRef} sx={{ mt: 0.5 }}>
          <List dense disablePadding aria-label="Matching jobs">
            {results.map((j) => (
              <ListItemButton key={j.id} onClick={() => onChange(j)} sx={{ py: 1 }}>
                <ListItemText
                  primary={jobLabel(j)}
                  secondary={[KIND[j.kind], j.clientName].filter(Boolean).join(' · ') || undefined}
                  primaryTypographyProps={{ sx: { overflowWrap: 'anywhere' } }}
                />
              </ListItemButton>
            ))}
          </List>
        </Paper>
      )}
    </Box>
  )
}
