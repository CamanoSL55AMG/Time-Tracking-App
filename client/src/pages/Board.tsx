import { useCallback, useEffect, useMemo, useState } from 'react'
import { Alert, Box, Button, ButtonBase, Chip, CircularProgress, Collapse, Paper, Stack, SvgIcon, Typography } from '@mui/material'
import { api, errorText, fmtElapsed, fmtTime, type Board, type BoardRow } from '../api'
import { divisionOpen, groupByDivision, loadOpen, personOpen, saveOpen, shortNames, type OpenState } from '../components/peopleGroups'

// Tower board: who is on the clock, on which job, in which phase, since when.
// Grouped by division, each division and each person opening and closing (Art,
// 2026-11-12); person headers show the first name only. What is open is remembered
// in this browser.

const OPEN_KEY = 'tt_board_open'

export default function BoardPage() {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => new Date())
  const [open, setOpen] = useState<OpenState>(() => loadOpen(OPEN_KEY))
  const update = (fn: (s: OpenState) => OpenState) =>
    setOpen((s) => {
      const next = fn(s)
      saveOpen(OPEN_KEY, next)
      return next
    })
  const groups = useMemo(() => groupByDivision(board?.rows ?? []), [board])
  const anyPersonOpen = (board?.rows ?? []).some((r) => personOpen(open, r.personId))
  const setAllPeople = (to: boolean) =>
    update((s) => ({ ...s, people: { ...s.people, ...Object.fromEntries((board?.rows ?? []).map((r) => [r.personId, to])) } }))

  const load = useCallback(async () => {
    try {
      setBoard(await api.board())
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
    setNow(new Date())
  }, [])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 30_000)
    return () => clearInterval(t)
  }, [load])

  if (!board) {
    return (
      <Stack alignItems="center" spacing={2} sx={{ py: 6 }}>
        {error ? <Alert severity="error">{error}</Alert> : <CircularProgress />}
        {error && <Button onClick={() => void load()}>Try again</Button>}
      </Stack>
    )
  }

  const on = board.rows.filter((r) => r.onClock)
  const away = board.rows.filter((r) => !r.onClock && r.off)
  const off = board.rows.filter((r) => !r.onClock && !r.off)

  return (
    <Stack spacing={2}>
      <Stack direction="row" alignItems="center" spacing={1} flexWrap="wrap" useFlexGap>
        <Chip color="success" label={`${on.length} on the clock`} sx={{ fontWeight: 700 }} />
        <Chip variant="outlined" label={`${off.length} done for now`} />
        {away.length > 0 && <Chip variant="outlined" color="info" label={`${away.length} off today`} />}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary">
          as of {fmtTime(board.asOf)}
        </Typography>
      </Stack>
      {error && <Alert severity="warning">{error}</Alert>}
      {board.rows.length === 0 && <Typography color="text.secondary">Nobody has punched today.</Typography>}

      {groups.length > 0 && (
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: -1 }}>
          <Button size="small" onClick={() => setAllPeople(!anyPersonOpen)}>
            {anyPersonOpen ? 'Close everyone' : 'Open everyone'}
          </Button>
        </Stack>
      )}

      {groups.map((g) => {
        const gOpen = divisionOpen(open, g.key)
        const onCount = g.rows.filter((r) => r.onClock).length
        const names = shortNames(g.rows.map((r) => ({ id: r.personId, name: r.name })))
        return (
          <Box key={g.key || '(none)'}>
            <ButtonBase
              onClick={() => update((s) => ({ ...s, divisions: { ...s.divisions, [g.key]: !gOpen } }))}
              aria-expanded={gOpen}
              sx={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', borderRadius: 1, px: 0.5, py: 0.75, gap: 1 }}
            >
              <Chevron open={gOpen} />
              <Typography sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
                {g.label}
              </Typography>
              {onCount > 0 && <Chip size="small" color="success" variant="outlined" label={`${onCount} on`} sx={{ flexShrink: 0 }} />}
              <Chip size="small" label={g.rows.length} sx={{ flexShrink: 0, fontWeight: 700 }} />
            </ButtonBase>
            <Collapse in={gOpen} unmountOnExit>
              <Stack spacing={1} sx={{ pt: 0.5, pl: { xs: 0, sm: 1.5 } }}>
                {g.rows.map((r) => {
                  const pOpen = personOpen(open, r.personId)
                  return (
                    <Paper key={r.personId} sx={{ opacity: r.onClock ? 1 : 0.65, overflow: 'hidden' }}>
                      <ButtonBase
                        onClick={() => update((s) => ({ ...s, people: { ...s.people, [r.personId]: !pOpen } }))}
                        aria-expanded={pOpen}
                        aria-label={`${r.name}${r.onClock ? ', on the clock' : ''}`}
                        title={r.name}
                        sx={{ width: '100%', justifyContent: 'flex-start', textAlign: 'left', px: 1.75, py: 1.25, gap: 1.5 }}
                      >
                        <Box sx={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, bgcolor: r.onClock ? 'success.main' : 'text.disabled' }} />
                        <Typography sx={{ fontWeight: 700, flex: 1, minWidth: 0 }} noWrap>
                          {names.get(r.personId) ?? r.name}
                        </Typography>
                        <Chevron open={pOpen} />
                      </ButtonBase>
                      <Collapse in={pOpen} unmountOnExit>
                        <Box sx={{ px: 1.75, pb: 1.5, pl: 'calc(14px + 22px)' }}>
                          <PersonDetail r={r} phaseCount={board.phaseCount} now={now} />
                        </Box>
                      </Collapse>
                    </Paper>
                  )
                })}
              </Stack>
            </Collapse>
          </Box>
        )
      })}
    </Stack>
  )
}

/** What the board showed for a person before grouping: phase, leave, job, where and hours. */
function PersonDetail({ r, phaseCount, now }: { r: BoardRow; phaseCount: number; now: Date }) {
  return (
    <Stack spacing={0.25}>
      {(r.off || r.phaseName) && (
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          {r.phaseName && (
            <Chip
              size="small"
              color={r.onClock ? 'secondary' : 'default'}
              variant={r.onClock ? 'filled' : 'outlined'}
              label={r.phaseIndex !== null ? `${r.phaseIndex + 1}/${r.phaseSteps ?? phaseCount} ${r.phaseName}` : r.phaseName}
              sx={{ maxWidth: '100%' }}
            />
          )}
          {r.off && <Chip size="small" color="info" variant="outlined" label={`Off · ${r.off.leaveType}`} />}
        </Stack>
      )}
      <Typography variant="body2" color="text.secondary" noWrap>
        {[r.jobName || '—', whereLabel(r.atShop, r.atSite)].filter(Boolean).join(' · ')}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {r.onClock
          ? `since ${fmtTime(r.since)} · ${fmtElapsed(r.since, now)} · ${r.hoursToday.toFixed(1)} h today`
          : r.off && !r.lastOut
            ? `${r.off.hours} h off today`
            : `out ${fmtTime(r.lastOut)} · ${r.hoursToday.toFixed(1)} h today`}
      </Typography>
    </Stack>
  )
}

/** Points right when closed, down when open. */
function Chevron({ open }: { open: boolean }) {
  return (
    <SvgIcon fontSize="small" sx={{ flexShrink: 0, color: 'text.secondary', transition: 'transform .15s', transform: open ? 'none' : 'rotate(-90deg)' }}>
      <path d="M7 10l5 5 5-5z" />
    </SvgIcon>
  )
}

/** Where the clock-in happened: the shop, the job site, or neither. */
function whereLabel(atShop: boolean | null, atSite: boolean | null | undefined): string {
  if (atShop === true) return 'at the shop'
  if (atSite === true) return 'at the site'
  if (atSite === false) return 'away from the site'
  if (atShop === false) return 'away from the shop'
  return ''
}
