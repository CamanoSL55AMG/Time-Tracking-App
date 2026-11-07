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
  // Set any Logbook role, admin included, through PUT /people/by-email. Meant for
  // the AIC Terminal key: Terminal's enrollment is where people and their app
  // roles are set. Without it a key can add people but not touch admins.
  'people:roles',
  'reports:read',
  'events:read',
  'assignments:write',
  'expenses:read',
  'expenses:approve',
  'payroll:read',
  'leave:read',
  'leave:write',
  'leave:approve',
] as const
export type Scope = (typeof SCOPES)[number]

// Scopes that only a signed-in person can hold.
export const SELF = 'punch:self'
export const KEYS_MANAGE = 'keys:manage'
/** Punch a crew in, to the next phase, or out together (crew leads). */
export const CREW = 'punch:crew'
/** A key may set any role, admin included (AIC Terminal's enrollment). */
export const PEOPLE_ROLES = 'people:roles'
/** Approve and reopen weekly timesheets. */
export const APPROVE = 'timesheets:approve'
/** Approve or turn down a person's request to fix their own time (a missed clock-in or
 *  clock-out). Managers, admins and payroll (Art, 2026-11-04); not crew leads. */
export const FIX_APPROVE = 'requests:approve'

export const ROLES = ['tech', 'lead', 'manager', 'payroll', 'admin'] as const
export type Role = (typeof ROLES)[number]

const TECH = [SELF, 'jobs:read']
// Leave (Art, 2026-11-07): crew leads see who is off but don't decide; managers,
// admins and payroll approve; payroll and admins also keep the balances
// (adjustments, opening-balance import, policies, accrual runs).
const LEAD = [...TECH, 'punch:read', 'people:read', CREW, 'leave:read']
const MANAGER = [...LEAD, APPROVE, FIX_APPROVE, 'punch:write:any', 'jobs:write', 'people:write', 'reports:read', 'events:read', 'assignments:write', 'expenses:read', 'expenses:approve', 'leave:approve']

export const ROLE_SCOPES: Record<Role, string[]> = {
  tech: TECH,
  lead: LEAD,
  manager: MANAGER,
  payroll: [SELF, 'jobs:read', 'punch:read', 'people:read', 'reports:read', APPROVE, FIX_APPROVE, 'expenses:read', 'expenses:approve', 'payroll:read', 'leave:read', 'leave:approve', 'leave:write'],
  admin: [...MANAGER, KEYS_MANAGE, 'payroll:read', 'leave:write'],
}

/** What the AIC Terminal (GED) key may do. link-ged creates the key with these;
 *  grant-ged-scopes brings an existing key up to date without rotating it. */
export const GED_KEY_SCOPES: Scope[] = ['punch:read', 'punch:write:any', 'jobs:read', 'jobs:write', 'people:read', 'people:write', 'people:roles', 'reports:read', 'events:read', 'assignments:write']

export const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v)
export const isScope = (v: unknown): v is Scope => typeof v === 'string' && (SCOPES as readonly string[]).includes(v)
