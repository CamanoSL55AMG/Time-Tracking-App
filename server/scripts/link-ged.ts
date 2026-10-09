// Connect GED to Time Tracking in one step:  npm run link-ged
//
// Creates an integration key for GED (revoking any earlier GED key) and writes it,
// with the Time Tracking addresses, into GED's server/.env. The key is never
// printed. Restart GED's server afterwards so it picks the settings up.
//
// Options:  --ged <path to GED server/.env>   (default ../../google-ecosystem-dashboard/server/.env)
//           --api <API base URL>              (default http://localhost:<PORT>/api/v1)
//           --app <app URL techs open>        (default http://localhost:5195)
import 'dotenv/config'
import fs from 'node:fs'
import path from 'node:path'
import { PrismaClient } from '@prisma/client'
import { generateKey } from '../src/auth/apiKeys.js'

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const gedEnv = path.resolve(arg('ged', '../../google-ecosystem-dashboard/server/.env'))
const apiUrl = arg('api', `http://localhost:${process.env.PORT || 5400}/api/v1`)
const appUrl = arg('app', 'http://localhost:5195')
const SCOPES = ['punch:read', 'punch:write:any', 'jobs:read', 'jobs:write', 'people:read', 'people:write', 'reports:read', 'events:read', 'assignments:write']

function setVars(file: string, vars: Record<string, string>) {
  const raw = fs.readFileSync(file, 'utf8')
  const nl = raw.includes('\r\n') ? '\r\n' : '\n'
  let text = raw
  for (const [k, v] of Object.entries(vars)) {
    const re = new RegExp(`^${k}=.*$`, 'm')
    if (re.test(text)) text = text.replace(re, `${k}=${v}`)
    else text = `${text.replace(/\s*$/, '')}${nl}${k}=${v}${nl}`
  }
  if (!text.includes('# Time Tracking app')) {
    text = text.replace(new RegExp(`^TIME_TRACKING_URL=`, 'm'), `# Time Tracking app (written by Time-Tracking-App: npm run link-ged)${nl}TIME_TRACKING_URL=`)
  }
  fs.writeFileSync(file, text)
}

async function main() {
  if (!fs.existsSync(gedEnv)) throw new Error(`GED settings not found at ${gedEnv}. Pass --ged <path to server/.env>.`)
  const prisma = new PrismaClient()
  try {
    const companies = await prisma.company.findMany({ take: 2 })
    if (companies.length !== 1) throw new Error('Expected exactly one company. Run `npm run seed` first.')
    const companyId = companies[0].id
    const old = await prisma.apiKey.updateMany({ where: { companyId, name: 'GED', revokedAt: null }, data: { revokedAt: new Date() } })
    const { key, prefix, keyHash } = generateKey()
    await prisma.apiKey.create({ data: { companyId, name: 'GED', prefix, keyHash, scopes: SCOPES } })
    setVars(gedEnv, { TIME_TRACKING_URL: apiUrl, TIME_TRACKING_API_KEY: key, TIME_TRACKING_APP_URL: appUrl })
    console.log(`Created a GED key (${prefix}...)${old.count ? ` and revoked ${old.count} older one(s)` : ''}.`)
    console.log(`Wrote TIME_TRACKING_URL, TIME_TRACKING_API_KEY and TIME_TRACKING_APP_URL into ${gedEnv}`)
    console.log("Restart GED's server so it picks them up.")
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
