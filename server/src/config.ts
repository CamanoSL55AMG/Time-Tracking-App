import 'dotenv/config'

const num = (v: string | undefined): number | null => {
  if (v === undefined || v.trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export const config = {
  port: num(process.env.PORT) ?? 5400,
  isProduction: process.env.NODE_ENV === 'production',
  jwtSecret: process.env.JWT_SECRET ?? '',
  addonSsoSecret: process.env.ADDON_SSO_SECRET ?? '',
  ssoAutoProvision: (process.env.SSO_AUTO_PROVISION ?? 'true').toLowerCase() !== 'false',
  // "Sign in with Google": the OAuth web client id (the same one GED uses is fine).
  // Empty = the Google button is not shown.
  googleClientId: (process.env.GOOGLE_CLIENT_ID ?? '').trim(),
  // Google Workspace domain whose people may be added automatically on their first
  // Google sign-in (e.g. morgansound.com). Empty = only people already in the app.
  googleAllowedDomain: (process.env.GOOGLE_ALLOWED_DOMAIN ?? '').trim().toLowerCase(),
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  sessionDays: 30,
  ssoAudience: 'time_tracking',
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE) ?? 300,
  // Parallel run with Timesheets.com: through this date (YYYY-MM-DD, company time)
  // the app asks people to make each punch in Timesheets.com too, because payroll
  // still runs from there. Empty = no reminder.
  parallelRunUntil: (process.env.PARALLEL_RUN_UNTIL ?? '').trim(),
  timesheetsUrl: (process.env.TIMESHEETS_MIRROR_URL ?? '').trim() || 'https://secure.timesheets.com/',
  // Where people open this app (the page, not the API). The Dashboard sign-in
  // returns here: <APP_URL>/api/v1/auth/dashboard/callback.
  appUrl: ((process.env.APP_URL ?? '').trim() || 'http://localhost:5195').replace(/\/+$/, ''),
  // "Sign in with Dashboard" (GED's sign-in service). Written by GED's
  // `npm run oidc:client`. Empty = the button is not shown.
  dashboardIssuer: (process.env.DASHBOARD_ISSUER ?? '').trim(),
  dashboardClientId: (process.env.DASHBOARD_CLIENT_ID ?? '').trim() || 'time_tracking',
  dashboardClientSecret: (process.env.DASHBOARD_CLIENT_SECRET ?? '').trim(),
  // Labor export for payroll (GET /payroll/labor), read by AIC Accounting. Off unless
  // PAYROLL_EXPORT_ENABLED=true, so nothing leaves while payroll still runs from
  // Timesheets.com.
  payrollExportEnabled: /^(1|true|yes|on)$/i.test((process.env.PAYROLL_EXPORT_ENABLED ?? '').trim()),
  // AIC Control Tower on/off switch (services/tower.ts). Both empty = not checked,
  // Logbook stays ON. TOWER_TOKEN is the aircraft's enrollment token from the Tower.
  towerUrl: (process.env.TOWER_URL ?? '').trim().replace(/\/+$/, ''),
  towerToken: (process.env.TOWER_TOKEN ?? '').trim(),
  towerCheckSeconds: Math.max(15, num(process.env.TOWER_CHECK_SECONDS) ?? 60),
}

/** Refuse to start with a missing or weak signing secret. */
export function assertConfig(): void {
  if (config.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is missing or shorter than 32 characters. Set it in server/.env (see .env.example).')
  }
}
