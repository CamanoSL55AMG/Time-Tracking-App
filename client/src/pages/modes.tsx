import { Box, ButtonBase, Paper, Stack, Typography } from '@mui/material'
import { fmtElapsed, fmtTime, type Punch, type WorkMode } from '../api'

// The start screen after sign-in: Install, Service, Office, Shop, CAD or Bench Repair. The choice
// decides which phases and jobs the clock screen offers first. It is kept on this
// phone for the day; once on the clock, the open segment's phase decides.

export const MODE_INFO: Record<WorkMode, { label: string; blurb: string; color: string }> = {
  install: { label: 'Install', blurb: 'Field day on a project: load, drive, work, drive back.', color: '#2e7d32' },
  service: { label: 'Service', blurb: 'Service calls: drive, arrive, complete, on to the next call.', color: '#1565c0' },
  office: { label: 'Office', blurb: 'One clock-in, switch between projects all day. Engineering, PM, admin.', color: '#6a1b9a' },
  shop: { label: 'Shop', blurb: 'Shop tasks against a project: UCI and rack building, prep, receiving.', color: '#e65100' },
  cad: { label: 'CAD', blurb: 'Drafting against a project: design, line diagrams, racks, submittals, as-builts.', color: '#00838f' },
  bench: { label: 'Bench Repair', blurb: 'Electronic Repair on a checked-in unit: diagnose, repair, test. Hours post to its SD invoice.', color: '#ad1457' },
}

const MODE_KEY = 'tt_mode'
const todayYmd = () => new Date().toLocaleDateString('en-CA')

/** The mode picked on this phone today, or null for a new day. */
export function readMode(): WorkMode | null {
  try {
    const v = JSON.parse(localStorage.getItem(MODE_KEY) ?? 'null') as { date?: string; mode?: string } | null
    return v && v.date === todayYmd() && v.mode && v.mode in MODE_INFO ? (v.mode as WorkMode) : null
  } catch {
    return null
  }
}
export function writeMode(mode: WorkMode | null): void {
  try {
    if (mode) localStorage.setItem(MODE_KEY, JSON.stringify({ date: todayYmd(), mode }))
    else localStorage.removeItem(MODE_KEY)
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
}

export function ModePicker({ name, current, onPick }: { name?: string; current?: WorkMode | null; onPick: (m: WorkMode) => void }) {
  return (
    <Stack spacing={2}>
      <Box>
        <Typography variant="h5" sx={{ fontWeight: 700 }}>
          {name ? `Hi, ${name.split(' ')[0]}.` : 'Start your day'}
        </Typography>
        <Typography color="text.secondary">What are you working on today?</Typography>
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1.5 }}>
        {(Object.keys(MODE_INFO) as WorkMode[]).map((m) => (
          <ButtonBase key={m} onClick={() => onPick(m)} sx={{ borderRadius: 2, textAlign: 'left', display: 'block' }} focusRipple>
            <Paper
              sx={{
                p: 2,
                height: '100%',
                minHeight: 128,
                borderLeft: `6px solid ${MODE_INFO[m].color}`,
                outline: current === m ? `2px solid ${MODE_INFO[m].color}` : 'none',
              }}
            >
              <Typography variant="h6" sx={{ fontWeight: 800, color: MODE_INFO[m].color }}>
                {MODE_INFO[m].label}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {MODE_INFO[m].blurb}
              </Typography>
            </Paper>
          </ButtonBase>
        ))}
      </Box>
    </Stack>
  )
}

const PALETTE = ['#1565c0', '#2e7d32', '#e65100', '#6a1b9a', '#00838f', '#ad1457', '#5d4037', '#827717']

/** A colour per job, the same for the same job all day. */
export function jobColor(jobId: string, code?: string): string {
  if (code === 'OVERHEAD') return '#9e9e9e'
  let h = 0
  for (const ch of jobId) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/** The day as one bar: a block per segment, coloured by job; gaps are breaks. */
export function DayTimeline({ segments, now }: { segments: Punch[]; now: Date }) {
  if (!segments.length) return null
  const start = new Date(segments[0].clockIn).getTime()
  const end = Math.max(...segments.map((p) => new Date(p.clockOut ?? now).getTime()), start + 60_000)
  const span = end - start
  const totals = new Map<string, { name: string; code: string; ms: number }>()
  for (const p of segments) {
    const ms = Math.max(0, new Date(p.clockOut ?? now).getTime() - new Date(p.clockIn).getTime())
    const t = totals.get(p.jobId) ?? { name: p.job.name, code: p.job.code, ms: 0 }
    t.ms += ms
    totals.set(p.jobId, t)
  }
  return (
    <Box>
      <Box sx={{ position: 'relative', height: 14, borderRadius: 1, bgcolor: 'action.hover', overflow: 'hidden' }}>
        {segments.map((p) => {
          const a = new Date(p.clockIn).getTime()
          const b = new Date(p.clockOut ?? now).getTime()
          return (
            <Box
              key={p.id}
              title={`${p.job.name} · ${p.phase?.short ?? ''} · ${fmtTime(p.clockIn)}–${p.clockOut ? fmtTime(p.clockOut) : 'now'}`}
              sx={{
                position: 'absolute',
                top: 0,
                bottom: 0,
                left: `${((a - start) / span) * 100}%`,
                width: `max(2px, ${((b - a) / span) * 100}%)`,
                bgcolor: jobColor(p.jobId, p.job.code),
                opacity: p.clockOut ? 0.85 : 1,
              }}
            />
          )
        })}
      </Box>
      <Stack direction="row" justifyContent="space-between">
        <Typography variant="caption" color="text.secondary">
          {fmtTime(segments[0].clockIn)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {segments[segments.length - 1].clockOut ? fmtTime(new Date(end).toISOString()) : 'now'}
        </Typography>
      </Stack>
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={1.5} sx={{ mt: 0.5 }}>
        {[...totals.entries()].map(([id, t]) => (
          <Stack key={id} direction="row" spacing={0.5} alignItems="center">
            <Box sx={{ width: 10, height: 10, borderRadius: '2px', bgcolor: jobColor(id, t.code) }} />
            <Typography variant="caption">
              {t.name} {fmtElapsed(new Date(0).toISOString(), new Date(t.ms))}
            </Typography>
          </Stack>
        ))}
      </Stack>
    </Box>
  )
}
