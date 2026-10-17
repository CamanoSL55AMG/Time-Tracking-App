import { createHash, randomBytes } from 'node:crypto'

// Integration keys look like tt_live_<43 url-safe characters>. Only the SHA-256 is
// stored, so a database leak does not leak working keys. The key is shown once.

export const KEY_PREFIX = 'tt_live_'

export const hashKey = (key: string): string => createHash('sha256').update(key).digest('hex')

export function generateKey(): { key: string; prefix: string; keyHash: string } {
  const key = KEY_PREFIX + randomBytes(32).toString('base64url')
  return { key, prefix: key.slice(0, KEY_PREFIX.length + 6), keyHash: hashKey(key) }
}

export const looksLikeKey = (token: string): boolean => token.startsWith(KEY_PREFIX)

// What a key (or a role) may do.
export const SCOPES = [
  'punch:read',
  'punch:write:any',
  'jobs:read',
  'jobs:write',
  'people:read',
  'people:write',
  'reports:read',
  'events:read',
  'assignments:write',
  'expenses:read',
  'expenses:write',
  'expenses:approve',
  'leave:read',
  'leave:write',
  'leave:approve',
] as const
export type Scope = (typeof SCOPES)[number]

// Scopes that only a signed-in person can hold.
export const SELF = 'punch:self'
export const KEYS_MANAGE = 'keys:manage'

export const ROLES = ['tech', 'lead', 'manager', 'payroll', 'admin'] as const
export type Role = (typeof ROLES)[number]

// SELF also covers a person's own expenses, leave balances and time-off requests.
const TECH = [SELF, 'jobs:read']
// Leads approve their crew's time off (spec §7.5); expenses go to a manager.
const LEAD = [...TECH, 'punch:read', 'people:read', 'leave:read', 'leave:approve']
const MANAGER = [
  ...LEAD,
  'punch:write:any',
  'jobs:write',
  'people:write',
  'reports:read',
  'events:read',
  'assignments:write',
  'expenses:read',
  'expenses:write',
  'expenses:approve',
  'leave:write',
]

export const ROLE_SCOPES: Record<Role, string[]> = {
  tech: TECH,
  lead: LEAD,
  manager: MANAGER,
  // Finance keeps the leave balances (opening balances, corrections) and sees expenses.
  payroll: [SELF, 'jobs:read', 'punch:read', 'people:read', 'reports:read', 'expenses:read', 'leave:read', 'leave:write'],
  admin: [...MANAGER, KEYS_MANAGE],
}

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)
export const isScope = (v: unknown): v is Scope => typeof v === 'string' && (SCOPES as readonly string[]).includes(v)
