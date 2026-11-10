// Kept apart from middleware.ts (which needs the database) so it can be unit tested.

interface Caller {
  via: 'session' | 'key'
  person: { mustChangePassword: boolean } | null
}

/**
 * Whether this request is held back until the person changes the password an admin
 * set for them (Person.mustChangePassword). Only sessions are held back: an API key
 * acting for the person never knew their password.
 * Still open: the sign-in endpoints under /auth/ (who am I, change password, and the
 * sign-ins themselves, whose new session is held back the same way) and /health.
 * path is relative to /api/v1, as Express gives it to the v1 router.
 */
export function passwordChangeBlocks(auth: Caller | undefined, path: string): boolean {
  if (!auth || auth.via !== 'session' || !auth.person?.mustChangePassword) return false
  return !(path.startsWith('/auth/') || path === '/health')
}
