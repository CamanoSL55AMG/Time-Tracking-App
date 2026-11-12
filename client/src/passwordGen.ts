// TESTED & APPROVED by Art 2026-11-07: password generator. See TESTED.md before changing.
// Password generator, modelled on Bitwarden's / Vaultwarden's: a length, toggles for
// A-Z, a-z, 0-9 and special characters, and "avoid ambiguous characters".
//
// Uses the browser's crypto.getRandomValues with rejection sampling, so every
// character is equally likely, and every set that is switched on appears at least
// once. The password is never logged or sent anywhere here; it only goes into the
// form, and the server stores the bcrypt hash as before.

export type PasswordOptions = {
  length: number
  upper: boolean
  lower: boolean
  digits: boolean
  special: boolean
  avoidAmbiguous: boolean
}

export const MIN_LENGTH = 10 // the server refuses anything shorter
export const MAX_LENGTH = 64

export const DEFAULT_OPTIONS: PasswordOptions = { length: 16, upper: true, lower: true, digits: true, special: false, avoidAmbiguous: true }

const SETS = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digits: '0123456789',
  special: '!@#$%^&*',
} as const
// Easy to misread on a phone or read out wrong: 0 O o, 1 I l.
const AMBIGUOUS = /[0Oo1Il]/g

type SetName = keyof typeof SETS

// A uniform random index below n, from the platform's secure random source.
function randomIndex(n: number): number {
  const limit = Math.floor(0x100000000 / n) * n
  const buf = new Uint32Array(1)
  for (;;) {
    crypto.getRandomValues(buf)
    if (buf[0] < limit) return buf[0] % n
  }
}

export function clampLength(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_OPTIONS.length
  return Math.min(MAX_LENGTH, Math.max(MIN_LENGTH, Math.round(n)))
}

export function generatePassword(options: PasswordOptions = DEFAULT_OPTIONS): string {
  const names = (Object.keys(SETS) as SetName[]).filter((k) => options[k])
  // With every set switched off, fall back to letters and digits rather than fail.
  const on: SetName[] = names.length ? names : ['upper', 'lower', 'digits']
  const sets = on.map((k) => (options.avoidAmbiguous ? SETS[k].replace(AMBIGUOUS, '') : SETS[k]))
  const alphabet = sets.join('')
  const length = clampLength(options.length)
  for (;;) {
    let out = ''
    for (let i = 0; i < length; i++) out += alphabet[randomIndex(alphabet.length)]
    if (sets.every((set) => [...out].some((c) => set.includes(c)))) return out
  }
}

// Remembered per browser, like the vault's generator. Storage can be blocked, so
// every read and write is guarded and the defaults always work.
const KEY = 'logbook.passwordOptions'

export function loadOptions(): PasswordOptions {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return DEFAULT_OPTIONS
    const o = { ...DEFAULT_OPTIONS, ...(JSON.parse(raw) as Partial<PasswordOptions>) }
    return { ...o, length: clampLength(Number(o.length)) }
  } catch {
    return DEFAULT_OPTIONS
  }
}

export function saveOptions(o: PasswordOptions): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(o))
  } catch {
    // not remembered; nothing else depends on it
  }
}

// Copy text to the clipboard. Falls back to a hidden text box where the Clipboard API
// is not available (plain http on the LAN). Returns whether the copy worked.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the older way
  }
  const box = document.createElement('textarea')
  box.value = text
  box.setAttribute('readonly', '')
  box.style.position = 'fixed'
  box.style.opacity = '0'
  document.body.appendChild(box)
  box.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(box)
  return ok
}
