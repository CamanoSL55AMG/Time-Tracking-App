import { createHash, randomBytes } from 'node:crypto'

// "Forgot password?" on the sign-in page. Kept apart from the route (and from the
// database) so it can be unit tested: the route hands in a store backed by Prisma,
// the tests an in-memory one.
//
// The rules:
// - The answer is the same whether or not the address has an account, and the
//   lookup, token and email happen after that answer has gone (routes/auth.ts), so
//   neither the words nor the timing say which emails exist.
// - Only active accounts get a link. Nothing is sent when email is not set up.
// - The link carries a random 32-byte token; only its SHA-256 is stored.
// - The link works once and expires after RESET_MINUTES.
// - At most one email per address per RESET_COOLDOWN_MINUTES.
// - Using it sets the new password, clears "must change password" and the token.
//   Like changing a password while signed in, it signs nobody out.

export const RESET_MINUTES = 60
export const RESET_COOLDOWN_MINUTES = 5
/** Same rule as changing a password while signed in (POST /auth/password). */
export const MIN_PASSWORD_LENGTH = 10

export const FORGOT_SENT =
  'If that email has a Logbook account, a link to choose a new password is on its way. ' +
  `It works once and expires in ${RESET_MINUTES} minutes.`
export const RESET_LINK_BAD = 'This link to choose a new password has expired or was already used. Ask for a new one from the sign-in page.'

export const hashResetToken = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex')

/** 32 random bytes as base64url: 43 characters of A-Z a-z 0-9 - _. */
export const newResetToken = (): string => randomBytes(32).toString('base64url')
const looksLikeToken = (t: string): boolean => /^[A-Za-z0-9_-]{43}$/.test(t)

export interface ResetPerson {
  id: string
  email: string
  name: string
  active: boolean
  resetExpiresAt: Date | null
  resetSentAt: Date | null
}

export interface ResetStore {
  findByEmail(email: string): Promise<ResetPerson | null>
  findByTokenHash(tokenHash: string): Promise<ResetPerson | null>
  saveToken(personId: string, tokenHash: string, expiresAt: Date, sentAt: Date): Promise<void>
  /**
   * Set the new password and clear the token, only while that token is still the
   * person's, unexpired and the account active. False when nothing was changed (for
   * example a second use racing the first).
   */
  consume(personId: string, tokenHash: string, now: Date, passwordHash: string): Promise<boolean>
  clearToken(personId: string): Promise<void>
}

export interface ResetMail {
  to: string
  subject: string
  text: string
}

export interface RequestDeps {
  store: ResetStore
  mailerConfigured: () => boolean
  send: (mail: ResetMail) => Promise<void>
  warn?: (message: string) => void
  now?: () => Date
}

export type RequestOutcome = 'sent' | 'mail_off' | 'no_account' | 'inactive' | 'cooldown'

/**
 * Email a one-time link to choose a new password, when the address belongs to an
 * active account and none was sent in the last few minutes. Runs after the caller
 * has already answered FORGOT_SENT. The outcome is for logs and tests only; it never
 * reaches the person who asked.
 */
export async function requestPasswordReset(deps: RequestDeps, rawEmail: string, origin: string): Promise<RequestOutcome> {
  const email = rawEmail.trim().toLowerCase()
  if (!deps.mailerConfigured()) {
    ;(deps.warn ?? console.warn)('[auth] "Forgot password?" was used but email is not set up (GMAIL_USER / GMAIL_APP_PASSWORD), so no link was sent.')
    return 'mail_off'
  }
  const person = await deps.store.findByEmail(email)
  if (!person) return 'no_account'
  if (!person.active) return 'inactive'
  const now = deps.now?.() ?? new Date()
  if (person.resetSentAt && now.getTime() - person.resetSentAt.getTime() < RESET_COOLDOWN_MINUTES * 60_000) return 'cooldown'

  const token = newResetToken()
  const expiresAt = new Date(now.getTime() + RESET_MINUTES * 60_000)
  await deps.store.saveToken(person.id, hashResetToken(token), expiresAt, now)
  await deps.send({
    to: person.email,
    subject: 'Choose a new Logbook password',
    text:
      `Hi ${person.name},\n\n` +
      'Someone (hopefully you) asked to reset your Logbook password.\n' +
      `Open this link to choose a new one. It works once and expires in ${RESET_MINUTES} minutes:\n\n` +
      `${resetLink(origin, token)}\n\n` +
      "If you didn't ask for this, ignore this email. Your current password keeps working.\n",
  })
  return 'sent'
}

/** The token rides in the address fragment, which browsers never send to a server or in a Referer. */
export const resetLink = (origin: string, token: string): string => `${origin.replace(/\/+$/, '')}/reset-password#token=${token}`

export type ResetResult = { ok: true; personId: string } | { ok: false; reason: 'weak_password' | 'bad_link' }

export interface ResetDeps {
  store: ResetStore
  hashPassword: (password: string) => Promise<string>
  now?: () => Date
}

/** Use a link: set the new password if the token is valid, unexpired and unused, for an active account. */
export async function resetPassword(deps: ResetDeps, token: string, password: string): Promise<ResetResult> {
  if (password.length < MIN_PASSWORD_LENGTH) return { ok: false, reason: 'weak_password' }
  if (!looksLikeToken(token)) return { ok: false, reason: 'bad_link' }
  const now = deps.now?.() ?? new Date()
  const tokenHash = hashResetToken(token)
  const person = await deps.store.findByTokenHash(tokenHash)
  if (!person) return { ok: false, reason: 'bad_link' }
  if (!person.active || !person.resetExpiresAt || person.resetExpiresAt.getTime() <= now.getTime()) {
    // A dead link is of no further use; drop it so it can't linger.
    await deps.store.clearToken(person.id)
    return { ok: false, reason: 'bad_link' }
  }
  const passwordHash = await deps.hashPassword(password)
  const changed = await deps.store.consume(person.id, tokenHash, now, passwordHash)
  return changed ? { ok: true, personId: person.id } : { ok: false, reason: 'bad_link' }
}
