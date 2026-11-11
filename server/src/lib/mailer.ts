/**
 * Zero-dependency Gmail SMTP mailer (ported from GED's server/src/lib/mailer.ts,
 * the same engine AV Inventory uses).
 *
 * Sends through smtp.gmail.com:465 (implicit TLS) with a Google App Password: no
 * OAuth, no nodemailer, nothing to npm-install. Set in server/.env:
 *
 *   GMAIL_USER=you@gmail.com
 *   GMAIL_APP_PASSWORD=xxxxxxxxxxxxxxxx   (Google Account -> Security ->
 *                                          2-Step Verification -> App passwords)
 *   MAIL_FROM_NAME=Logbook                 (optional display name)
 *
 * Copy GMAIL_USER and GMAIL_APP_PASSWORD from GED's server/.env: one mail identity
 * for the whole Morgan Sound ecosystem. Deliberately minimal: plain text (+ optional
 * html), one or more recipients, no attachments. Used by "Forgot password?".
 */

import tls from 'node:tls'
import { config } from '../config.js'

export const mailerConfigured = (): boolean => Boolean(config.gmailUser && config.gmailAppPassword)

const CRLF = '\r\n'
const SMTP_HOST = 'smtp.gmail.com'
const SMTP_PORT = 465
const TIMEOUT_MS = 25_000

class SmtpError extends Error {
  code?: number
  constructor(message: string, code?: number) {
    super(message)
    this.name = 'SmtpError'
    this.code = code
  }
}

/** Base64 for SMTP AUTH and encoded-word headers. */
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')

/** RFC 2047 encoded-word when the value isn't plain ASCII (e.g. em-dashes). */
const headerValue = (s: string): string => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`)

/** An address that can go into an SMTP command and a header as-is. */
const safeAddress = (s: string): boolean => /^[^\s<>,;:"\\]+@[^\s<>,;:"\\]+$/.test(s)

export interface MailMessage {
  to: string | string[]
  subject: string
  text: string
  html?: string
  replyTo?: string
  /** Display name for the From header (the address is always GMAIL_USER). */
  fromName?: string
}

/**
 * Minimal SMTP conversation. Each step sends one command and waits for the complete
 * (possibly multiline "250-...") response, checking the status code.
 */
export async function sendMail(opts: MailMessage): Promise<void> {
  if (!mailerConfigured()) {
    throw new SmtpError(
      'Email is not configured: set GMAIL_USER and GMAIL_APP_PASSWORD in server/.env ' +
        '(App Password: Google Account -> Security -> 2-Step Verification -> App passwords).',
    )
  }
  const user = config.gmailUser
  const pass = config.gmailAppPassword
  const recipients = (Array.isArray(opts.to) ? opts.to : [opts.to]).map((r) => r.trim()).filter(Boolean)
  if (!recipients.length) throw new SmtpError('No recipients')
  const bad = recipients.find((r) => !safeAddress(r))
  if (bad) throw new SmtpError('A recipient address is not valid.')
  if (opts.replyTo && !safeAddress(opts.replyTo)) throw new SmtpError('The reply-to address is not valid.')

  const socket = tls.connect({ host: SMTP_HOST, port: SMTP_PORT, servername: SMTP_HOST })
  socket.setEncoding('utf8')
  socket.setTimeout(TIMEOUT_MS, () => socket.destroy(new SmtpError('SMTP timeout')))

  let buffer = ''
  let pending: { resolve: (line: string) => void; reject: (err: Error) => void } | null = null

  const feed = () => {
    // A response is complete when its last line is "NNN " (space, not dash).
    const lines = buffer.split(CRLF).filter(Boolean)
    const last = lines[lines.length - 1]
    if (last && /^\d{3} /.test(last)) {
      const full = buffer
      buffer = ''
      pending?.resolve(full)
      pending = null
    }
  }

  socket.on('data', (chunk: string) => {
    buffer += chunk
    feed()
  })
  socket.on('error', (err) => pending?.reject(err))
  socket.on('close', () => pending?.reject(new SmtpError('SMTP connection closed unexpectedly')))

  const waitReply = (): Promise<string> =>
    new Promise((resolve, reject) => {
      pending = { resolve, reject }
      feed() // the response may already be buffered
    })

  const expect = (reply: string, ...codes: number[]) => {
    const code = Number(reply.slice(0, 3))
    if (!codes.includes(code)) throw new SmtpError(`SMTP ${reply.split(CRLF)[0] ?? reply}`.trim(), code)
  }

  const command = async (cmd: string, ...codes: number[]): Promise<string> => {
    socket.write(cmd + CRLF)
    const reply = await waitReply()
    expect(reply, ...codes)
    return reply
  }

  try {
    expect(await waitReply(), 220) // greeting
    await command('EHLO logbook.morgansound.local', 250)
    await command('AUTH LOGIN', 334)
    await command(b64(user), 334)
    try {
      await command(b64(pass), 235)
    } catch (err) {
      throw new SmtpError(
        `Gmail rejected the login for ${user}: check GMAIL_APP_PASSWORD (it must be an App Password, ` +
          `not the normal account password). ${err instanceof Error ? err.message : ''}`.trim(),
        err instanceof SmtpError ? err.code : undefined,
      )
    }
    await command(`MAIL FROM:<${user}>`, 250)
    for (const rcpt of recipients) await command(`RCPT TO:<${rcpt}>`, 250, 251)
    await command('DATA', 354)

    const boundary = `logbook-${Math.random().toString(36).slice(2)}`
    const headers = [
      `From: ${headerValue(opts.fromName?.trim() || config.mailFromName)} <${user}>`,
      `To: ${recipients.join(', ')}`,
      ...(opts.replyTo ? [`Reply-To: ${opts.replyTo}`] : []),
      `Subject: ${headerValue(opts.subject.replace(/[\r\n]+/g, ' '))}`,
      `Date: ${new Date().toUTCString()}`,
      'MIME-Version: 1.0',
      ...(opts.html
        ? [`Content-Type: multipart/alternative; boundary="${boundary}"`]
        : ['Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit']),
    ]
    const body = opts.html
      ? [
          `--${boundary}`,
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          opts.text,
          `--${boundary}`,
          'Content-Type: text/html; charset=UTF-8',
          'Content-Transfer-Encoding: 8bit',
          '',
          opts.html,
          `--${boundary}--`,
        ].join(CRLF)
      : opts.text

    // Dot-stuffing per RFC 5321 section 4.5.2, then the terminating ".".
    const message = (headers.join(CRLF) + CRLF + CRLF + body)
      .split(/\r?\n/)
      .map((line) => (line.startsWith('.') ? '.' + line : line))
      .join(CRLF)
    socket.write(message + CRLF + '.' + CRLF)
    expect(await waitReply(), 250)
    await command('QUIT', 221).catch(() => undefined) // best-effort goodbye
  } finally {
    socket.removeAllListeners('close')
    socket.end()
    socket.destroy()
  }
}
