import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Alert, Box, Button, Checkbox, CircularProgress, FormControlLabel, Paper, Stack, Typography } from '@mui/material'
import { api, errorText, type TermsDocument, type TermsStatus } from '../api'

// First sign-in terms: the Privacy Policy, the EULA, then the AIC Platform Terms, one
// screen and one tick each. Shown instead of the app until every one is accepted.

export default function TermsGate({ onDone, onSignOut }: { onDone: () => void; onSignOut: () => void }) {
  const [status, setStatus] = useState<TermsStatus | null>(null)
  const [doc, setDoc] = useState<TermsDocument | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  // "Step N of M": M is how many were pending when the screen opened.
  const [total, setTotal] = useState(0)
  const done = useRef(onDone)
  done.current = onDone
  const box = useRef<HTMLDivElement>(null)

  const show = useCallback(async (s: TermsStatus) => {
    setStatus(s)
    setAgreed(false)
    if (s.complete || !s.pending.length) {
      done.current()
      return
    }
    setTotal((t) => Math.max(t, s.documents.filter((d) => d.accepted).length + s.pending.length))
    const next = await api.termsDocument(s.pending[0].id)
    setDoc(next)
    box.current?.scrollTo({ top: 0 })
  }, [])

  const load = useCallback(async () => {
    setBusy(true)
    setError('')
    try {
      await show(await api.termsStatus())
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [show])

  useEffect(() => {
    void load()
  }, [load])

  const accept = async () => {
    if (!doc || !agreed) return
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await show(await api.acceptTerms(doc.id, doc.version))
    } catch (err) {
      // Changed or out of order: say why, then show what is current now.
      setNotice(errorText(err))
      try {
        await show(await api.termsStatus())
      } catch (again) {
        setError(errorText(again))
      }
    } finally {
      setBusy(false)
    }
  }

  const pendingCount = status?.pending.length ?? 0
  const step = Math.max(1, total - pendingCount + 1)

  // Most sign-ins have nothing to accept: show only a spinner until that is known.
  if ((!status || status.complete) && !error) {
    return (
      <Box sx={{ minHeight: '100dvh', display: 'grid', placeItems: 'center' }}>
        <CircularProgress />
      </Box>
    )
  }

  return (
    <Box sx={{ minHeight: '100dvh', display: 'flex', justifyContent: 'center', p: { xs: 2, sm: 3 } }}>
      <Paper variant="outlined" sx={{ width: '100%', maxWidth: 720, p: { xs: 2, sm: 3 }, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Stack direction="row" alignItems="baseline" justifyContent="space-between" gap={2} flexWrap="wrap">
          <Typography variant="h5" component="h1" sx={{ fontWeight: 700 }}>
            Before you start
          </Typography>
          {doc && total > 0 && (
            <Typography variant="body2" color="text.secondary">
              Step {step} of {total}
            </Typography>
          )}
        </Stack>

        {notice && <Alert severity="warning">{notice}</Alert>}
        {error && (
          <Alert
            severity="error"
            action={
              <Button color="inherit" size="small" onClick={() => void load()} disabled={busy}>
                Try again
              </Button>
            }
          >
            {error}
          </Alert>
        )}

        {!doc && !error && (
          <Box sx={{ display: 'grid', placeItems: 'center', py: 6 }}>
            <CircularProgress />
          </Box>
        )}

        {doc && (
          <>
            <Box>
              <Typography variant="h6" component="h2" sx={{ fontWeight: 700 }}>
                {doc.title}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Version {doc.version}
              </Typography>
            </Box>
            <Box
              ref={box}
              tabIndex={0}
              aria-label={doc.title}
              sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 2, maxHeight: '55dvh', overflowY: 'auto', bgcolor: 'background.default' }}
            >
              <Markdown text={doc.text} />
            </Box>
            <FormControlLabel
              control={<Checkbox checked={agreed} onChange={(e) => setAgreed(e.target.checked)} disabled={busy} />}
              label={`I have read and agree to the ${doc.title}`}
            />
          </>
        )}

        <Stack direction="row" justifyContent="space-between" gap={2}>
          <Button onClick={onSignOut}>
            Sign out
          </Button>
          {doc && (
            <Button variant="contained" onClick={() => void accept()} disabled={!agreed || busy}>
              Accept
            </Button>
          )}
        </Stack>
      </Paper>
    </Box>
  )
}

// ─── Just enough Markdown ───────────────────────────────────────────────────
// Headings, paragraphs, **bold**, *italic* and lists, built as React elements, so no
// HTML from the file ever reaches the page.

type Block = { kind: 'h'; level: number; text: string } | { kind: 'p'; text: string } | { kind: 'ul' | 'ol'; items: string[] }

function parse(md: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  let list: { kind: 'ul' | 'ol'; items: string[] } | null = null
  const flush = () => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') })
    para = []
    if (list) blocks.push(list)
    list = null
  }
  for (const raw of md.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    const ul = /^[-*+]\s+(.*)$/.exec(line)
    const ol = /^\d+[.)]\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ kind: 'h', level: h[1].length, text: h[2] })
    } else if (ul || ol) {
      const kind = ul ? 'ul' : 'ol'
      if (para.length || (list && list.kind !== kind)) flush()
      if (!list) list = { kind, items: [] }
      list.items.push((ul ?? ol)![1])
    } else if (list && /^\s/.test(raw)) {
      // An indented line continues the list item above it.
      list.items[list.items.length - 1] += ` ${line}`
    } else {
      if (list) flush()
      para.push(line)
    }
  }
  flush()
  return blocks
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g).map((part, i) => {
    if (/^(\*\*|__).+\1$/.test(part)) return <strong key={i}>{part.slice(2, -2)}</strong>
    if (/^([*_]).+\1$/.test(part)) return <em key={i}>{part.slice(1, -1)}</em>
    return <Fragment key={i}>{part}</Fragment>
  })
}

function Markdown({ text }: { text: string }) {
  return (
    <Box sx={{ '& > :first-of-type': { mt: 0 }, '& p': { my: 1.25 }, '& li': { mb: 0.5 } }}>
      {parse(text).map((b, i) => {
        if (b.kind === 'h') {
          const variant = b.level === 1 ? 'h6' : 'subtitle1'
          return (
            <Typography key={i} variant={variant} component={`h${Math.min(6, b.level + 2)}` as 'h3'} sx={{ fontWeight: 700, mt: 2, mb: 1 }}>
              {inline(b.text)}
            </Typography>
          )
        }
        if (b.kind === 'p')
          return (
            <Typography key={i} variant="body2" component="p">
              {inline(b.text)}
            </Typography>
          )
        const List = b.kind
        return (
          <Box key={i} component={List} sx={{ pl: 3, my: 1 }}>
            {b.items.map((it, j) => (
              <Typography key={j} variant="body2" component="li">
                {inline(it)}
              </Typography>
            ))}
          </Box>
        )
      })}
    </Box>
  )
}
