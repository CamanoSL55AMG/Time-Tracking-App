import { useCallback, useEffect, useState } from 'react'
import { Alert, Box, Button, Chip, Paper, Stack, Switch, TextField, Typography } from '@mui/material'
import { errorText, fmtMoney, money, todayYmd, type ExpenseCategory, type ExpenseReport, type MileageRate } from '../api'

// Expense setup for the office: categories and the account code each posts to,
// mileage rates by date, and approved reports waiting to be paid or posted.

export default function ManageExpenses({ canApprove }: { canApprove: boolean }) {
  const [cats, setCats] = useState<ExpenseCategory[]>([])
  const [rates, setRates] = useState<MileageRate[]>([])
  const [approved, setApproved] = useState<ExpenseReport[]>([])
  const [error, setError] = useState('')
  const [newCat, setNewCat] = useState({ name: '', accountCode: '' })
  const [newRate, setNewRate] = useState({ effectiveFrom: `${new Date().getFullYear() + 1}-01-01`, centsPerMile: '', note: '' })
  const [codes, setCodes] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const [c, r, a] = await Promise.all([money.categories(true), money.rates(), canApprove ? money.reports({ status: 'approved' }) : Promise.resolve([])])
      setCats(c)
      setCodes(Object.fromEntries(c.map((x) => [x.id, x.accountCode])))
      setRates(r.data)
      setApproved(a)
      setError('')
    } catch (err) {
      setError(errorText(err))
    }
  }, [canApprove])
  useEffect(() => {
    void load()
  }, [load])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const fmtDate = (ymd: string) => new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  const today = todayYmd()
  const current = rates.find((r) => r.effectiveFrom <= today)

  return (
    <Stack spacing={2}>
      {error && (
        <Alert severity="error" onClose={() => setError('')}>
          {error}
        </Alert>
      )}

      {canApprove && approved.length > 0 && (
        <>
          <Typography variant="overline" color="text.secondary">
            Approved, not yet paid or posted
          </Typography>
          {approved.map((r) => (
            <Paper key={r.id} sx={{ p: 1.5 }}>
              <Stack direction="row" spacing={1.5} alignItems="center">
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{ fontWeight: 600 }} noWrap>
                    {r.person?.name} · {fmtMoney(r.totalCents)}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {fmtMoney(r.reimbursableCents)} to pay back · {fmtMoney(r.companyCardCents)} company card
                    {r.decidedAt ? ` · approved ${new Date(r.decidedAt).toLocaleDateString()}` : ''}
                  </Typography>
                </Box>
                <Button size="small" variant="outlined" disabled={busy} onClick={() => void run(() => money.markExported(r.id))}>
                  Mark paid / posted
                </Button>
              </Stack>
            </Paper>
          ))}
        </>
      )}

      <Typography variant="overline" color="text.secondary">
        Categories
      </Typography>
      <Typography variant="body2" color="text.secondary">
        The account code is where accounting posts each category. Turning a category off hides it from new expenses; old ones keep it.
      </Typography>
      {cats.map((c) => (
        <Paper key={c.id} sx={{ p: 1.5, opacity: c.active ? 1 : 0.55 }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
              {c.name} {c.mileage && <Chip size="small" label="miles" sx={{ ml: 0.5 }} />}
            </Typography>
            <TextField
              size="small"
              label="Account code"
              value={codes[c.id] ?? ''}
              onChange={(e) => setCodes({ ...codes, [c.id]: e.target.value })}
              onBlur={() => (codes[c.id] ?? '') !== c.accountCode && void run(() => money.saveCategory(c.id, { accountCode: codes[c.id] ?? '' }))}
              sx={{ width: 112, flexShrink: 0 }}
            />
            <Switch checked={c.active} onChange={() => void run(() => money.saveCategory(c.id, { active: !c.active }))} inputProps={{ 'aria-label': `${c.name} in use` }} />
          </Stack>
        </Paper>
      ))}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <TextField size="small" label="New category" value={newCat.name} onChange={(e) => setNewCat({ ...newCat, name: e.target.value })} sx={{ flex: 1, minWidth: 160 }} />
        <TextField size="small" label="Account code" value={newCat.accountCode} onChange={(e) => setNewCat({ ...newCat, accountCode: e.target.value })} sx={{ width: 140 }} />
        <Button
          variant="outlined"
          disabled={busy || !newCat.name.trim()}
          onClick={() =>
            void run(async () => {
              await money.addCategory({ name: newCat.name.trim(), accountCode: newCat.accountCode.trim(), mileage: false })
              setNewCat({ name: '', accountCode: '' })
            })
          }
        >
          Add
        </Button>
      </Stack>

      <Typography variant="overline" color="text.secondary">
        Mileage rate
      </Typography>
      <Typography variant="body2">
        {current ? `${current.centsPerMile}¢ a mile since ${fmtDate(current.effectiveFrom)}${current.note ? ` (${current.note})` : ''}.` : 'No rate is in force today. Add one below.'}
      </Typography>
      {rates.map((r) => (
        <Typography key={r.id} variant="body2" color="text.secondary">
          From {fmtDate(r.effectiveFrom)}: {r.centsPerMile}¢ {r.note && `· ${r.note}`}
        </Typography>
      ))}
      <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
        <TextField size="small" type="date" label="From" value={newRate.effectiveFrom} onChange={(e) => setNewRate({ ...newRate, effectiveFrom: e.target.value })} InputLabelProps={{ shrink: true }} />
        <TextField size="small" label="Cents per mile" inputMode="decimal" value={newRate.centsPerMile} onChange={(e) => setNewRate({ ...newRate, centsPerMile: e.target.value })} sx={{ width: 140 }} />
        <TextField size="small" label="Note" placeholder="IRS business rate" value={newRate.note} onChange={(e) => setNewRate({ ...newRate, note: e.target.value })} sx={{ flex: 1, minWidth: 140 }} />
        <Button
          variant="outlined"
          disabled={busy || !(Number(newRate.centsPerMile) > 0) || !newRate.effectiveFrom}
          onClick={() =>
            void run(async () => {
              await money.addRate({ effectiveFrom: newRate.effectiveFrom, centsPerMile: Number(newRate.centsPerMile), note: newRate.note.trim() })
              setNewRate({ ...newRate, centsPerMile: '', note: '' })
            })
          }
        >
          Add rate
        </Button>
      </Stack>
    </Stack>
  )
}
