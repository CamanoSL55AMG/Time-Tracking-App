import test from 'node:test'
import assert from 'node:assert/strict'
import {
  FORGOT_SENT,
  hashResetToken,
  requestPasswordReset,
  resetLink,
  resetPassword,
  RESET_COOLDOWN_MINUTES,
  RESET_MINUTES,
  type ResetMail,
  type ResetPerson,
  type ResetStore,
} from './passwordReset.js'

// An in-memory stand-in for the Person table, with the same conditional update the
// Prisma store does (routes/auth.ts resetStore.consume).
interface Row extends ResetPerson {
  passwordHash: string | null
  mustChangePassword: boolean
  resetTokenHash: string | null
}

function memoryStore(rows: Row[]): ResetStore & { rows: Row[] } {
  const byId = (id: string) => rows.find((r) => r.id === id)!
  return {
    rows,
    findByEmail: async (email) => rows.find((r) => r.email === email) ?? null,
    findByTokenHash: async (h) => rows.find((r) => r.resetTokenHash === h) ?? null,
    saveToken: async (id, h, exp, sent) => {
      Object.assign(byId(id), { resetTokenHash: h, resetExpiresAt: exp, resetSentAt: sent })
    },
    consume: async (id, h, now, passwordHash) => {
      const r = byId(id)
      if (r.resetTokenHash !== h || !r.resetExpiresAt || r.resetExpiresAt <= now || !r.active) return false
      Object.assign(r, { passwordHash, mustChangePassword: false, resetTokenHash: null, resetExpiresAt: null })
      return true
    },
    clearToken: async (id) => {
      Object.assign(byId(id), { resetTokenHash: null, resetExpiresAt: null })
    },
  }
}

const person = (over: Partial<Row> = {}): Row => ({
  id: 'p1',
  email: 'tech@example.com',
  name: 'Tech',
  active: true,
  passwordHash: 'old-hash',
  mustChangePassword: true,
  resetTokenHash: null,
  resetExpiresAt: null,
  resetSentAt: null,
  ...over,
})

const ORIGIN = 'https://logbook.example.com'
const T0 = new Date('2026-11-11T17:00:00Z')
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000)

function setup(rows: Row[], opts: { mail?: boolean } = {}) {
  const store = memoryStore(rows)
  const sent: ResetMail[] = []
  const warnings: string[] = []
  let now = T0
  const deps = {
    store,
    mailerConfigured: () => opts.mail ?? true,
    send: async (m: ResetMail) => {
      sent.push(m)
    },
    warn: (m: string) => warnings.push(m),
    now: () => now,
  }
  const resetDeps = { store, hashPassword: async (pw: string) => `hashed:${pw}`, now: () => now }
  const tokenFrom = (m: ResetMail) => {
    const match = /#token=([A-Za-z0-9_-]+)/.exec(m.text)
    assert.ok(match, 'the email carries a link with a token')
    return match[1]
  }
  return { store, sent, warnings, deps, resetDeps, tokenFrom, setNow: (d: Date) => (now = d) }
}

test('the answer says nothing about whether the account exists', () => {
  // The route answers this one constant before any lookup; it must not name the address.
  assert.ok(FORGOT_SENT.startsWith('If that email has'))
  assert.ok(!FORGOT_SENT.includes('@'))
})

test('an unknown email gets no email and no token', async () => {
  const s = setup([person()])
  assert.equal(await requestPasswordReset(s.deps, 'nobody@example.com', ORIGIN), 'no_account')
  assert.equal(s.sent.length, 0)
  assert.equal(s.store.rows[0].resetTokenHash, null)
})

test('an inactive account gets nothing', async () => {
  const s = setup([person({ active: false })])
  assert.equal(await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN), 'inactive')
  assert.equal(s.sent.length, 0)
  assert.equal(s.store.rows[0].resetTokenHash, null)
})

test('no email set up: nothing is sent, a warning is logged', async () => {
  const s = setup([person()], { mail: false })
  assert.equal(await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN), 'mail_off')
  assert.equal(s.sent.length, 0)
  assert.equal(s.warnings.length, 1)
  assert.equal(s.store.rows[0].resetTokenHash, null)
})

test('an active account gets a link; only the hash of its token is stored', async () => {
  const s = setup([person()])
  assert.equal(await requestPasswordReset(s.deps, '  Tech@Example.com ', ORIGIN), 'sent')
  assert.equal(s.sent.length, 1)
  assert.equal(s.sent[0].to, 'tech@example.com')
  const token = s.tokenFrom(s.sent[0])
  assert.equal(token.length, 43) // 32 random bytes, base64url
  assert.ok(s.sent[0].text.includes(resetLink(ORIGIN, token)))
  const row = s.store.rows[0]
  assert.equal(row.resetTokenHash, hashResetToken(token))
  assert.notEqual(row.resetTokenHash, token)
  assert.equal(row.resetExpiresAt?.getTime(), at(RESET_MINUTES).getTime())
})

test('at most one email per address every few minutes', async () => {
  const s = setup([person()])
  assert.equal(await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN), 'sent')
  s.setNow(at(RESET_COOLDOWN_MINUTES - 1))
  assert.equal(await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN), 'cooldown')
  assert.equal(s.sent.length, 1)
  s.setNow(at(RESET_COOLDOWN_MINUTES + 1))
  assert.equal(await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN), 'sent')
  assert.equal(s.sent.length, 2)
  // The newer link replaces the older one.
  assert.equal((await resetPassword(s.resetDeps, s.tokenFrom(s.sent[0]), 'a-new-password')).ok, false)
  assert.equal((await resetPassword(s.resetDeps, s.tokenFrom(s.sent[1]), 'a-new-password')).ok, true)
})

test('the link sets the password, clears "must change password", and works only once', async () => {
  const s = setup([person()])
  await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN)
  const token = s.tokenFrom(s.sent[0])
  s.setNow(at(10))
  const first = await resetPassword(s.resetDeps, token, 'a-new-password')
  assert.deepEqual(first, { ok: true, personId: 'p1' })
  const row = s.store.rows[0]
  assert.equal(row.passwordHash, 'hashed:a-new-password')
  assert.equal(row.mustChangePassword, false)
  assert.equal(row.resetTokenHash, null)
  assert.equal(row.resetExpiresAt, null)

  const second = await resetPassword(s.resetDeps, token, 'another-password')
  assert.deepEqual(second, { ok: false, reason: 'bad_link' })
  assert.equal(row.passwordHash, 'hashed:a-new-password')
})

test('two uses at the same moment: only one changes the password', async () => {
  const s = setup([person()])
  await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN)
  const token = s.tokenFrom(s.sent[0])
  const results = await Promise.all([resetPassword(s.resetDeps, token, 'first-password'), resetPassword(s.resetDeps, token, 'second-password')])
  assert.equal(results.filter((r) => r.ok).length, 1)
})

test('the link expires after an hour', async () => {
  const s = setup([person()])
  await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN)
  const token = s.tokenFrom(s.sent[0])
  s.setNow(at(RESET_MINUTES))
  assert.deepEqual(await resetPassword(s.resetDeps, token, 'a-new-password'), { ok: false, reason: 'bad_link' })
  assert.equal(s.store.rows[0].passwordHash, 'old-hash')
  assert.equal(s.store.rows[0].resetTokenHash, null) // the dead link is dropped
})

test('a link stops working when the account is switched off', async () => {
  const s = setup([person()])
  await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN)
  const token = s.tokenFrom(s.sent[0])
  s.store.rows[0].active = false
  assert.deepEqual(await resetPassword(s.resetDeps, token, 'a-new-password'), { ok: false, reason: 'bad_link' })
  assert.equal(s.store.rows[0].passwordHash, 'old-hash')
})

test('the new password follows the usual rule, and a short one keeps the link', async () => {
  const s = setup([person()])
  await requestPasswordReset(s.deps, 'tech@example.com', ORIGIN)
  const token = s.tokenFrom(s.sent[0])
  assert.deepEqual(await resetPassword(s.resetDeps, token, 'short'), { ok: false, reason: 'weak_password' })
  assert.equal((await resetPassword(s.resetDeps, token, 'long-enough-1')).ok, true)
})

test('made-up and malformed tokens are refused', async () => {
  const s = setup([person()])
  assert.deepEqual(await resetPassword(s.resetDeps, 'x'.repeat(43), 'a-new-password'), { ok: false, reason: 'bad_link' })
  assert.deepEqual(await resetPassword(s.resetDeps, 'not a token', 'a-new-password'), { ok: false, reason: 'bad_link' })
})
