// Bring the AIC Terminal (GED) key up to date:  npm run grant-ged-scopes
//
// Adds any scope GED now needs (people:roles, so Terminal's enrollment can set
// Logbook roles, admin included) to the GED key that is already in use. The key
// itself does not change, so GED's server/.env and GED itself are left alone.
// Safe to repeat. If there is no GED key yet, run `npm run link-ged` instead.
import 'dotenv/config'
import { PrismaClient } from '@prisma/client'
import { GED_KEY_SCOPES } from '../src/auth/apiKeys.js'

async function main() {
  const prisma = new PrismaClient()
  try {
    const keys = await prisma.apiKey.findMany({ where: { name: 'GED', revokedAt: null } })
    if (keys.length === 0) throw new Error('No GED key found. Run `npm run link-ged` to create one.')
    for (const k of keys) {
      const missing = GED_KEY_SCOPES.filter((s) => !k.scopes.includes(s))
      if (missing.length === 0) {
        console.log(`GED key ${k.prefix}... already has every scope it needs.`)
        continue
      }
      await prisma.apiKey.update({ where: { id: k.id }, data: { scopes: [...new Set([...k.scopes, ...missing])] } })
      console.log(`GED key ${k.prefix}...: added ${missing.join(', ')}.`)
    }
  } finally {
    await prisma.$disconnect()
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
})
