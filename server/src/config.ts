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
  corsOrigins: (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  sessionDays: 30,
  ssoAudience: 'time_tracking',
  rateLimitPerMinute: num(process.env.RATE_LIMIT_PER_MINUTE) ?? 300,
}

/** Refuse to start with a missing or weak signing secret. */
export function assertConfig(): void {
  if (config.jwtSecret.length < 32) {
    throw new Error('JWT_SECRET is missing or shorter than 32 characters. Set it in server/.env (see .env.example).')
  }
}
