// One-time setup: the company, the first admin, the phases of the day and two
// standing jobs. Safe to run again; it only adds what is missing.
//   npm run seed
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const PHASES = [
  { key: 'shop-load', name: 'Shop — load vans', short: 'Load', atShop: true },
  { key: 'travel-out', name: 'Drive to site', short: 'Drive out', atShop: false },
  { key: 'unload', name: 'Unload at site', short: 'Unload', atShop: false },
  { key: 'work', name: 'Work on project', short: 'Work', atShop: false },
  { key: 'cleanup', name: 'Clean up', short: 'Clean up', atShop: false },
  { key: 'travel-back', name: 'Drive to shop', short: 'Drive back', atShop: false },
  { key: 'shop-unload', name: 'Shop — unload / put away', short: 'Put away', atShop: true },
]

const num = (v: string | undefined) => (v && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)

async function main() {
  const name = (process.env.COMPANY_NAME ?? '').trim()
  const email = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase()
  const password = process.env.ADMIN_PASSWORD ?? ''
  if (!name) throw new Error('Set COMPANY_NAME in server/.env')
  if (!email.includes('@')) throw new Error('Set ADMIN_EMAIL in server/.env')

  let company = await prisma.company.findFirst({ where: { name } })
  if (!company) {
    company = await prisma.company.create({
      data: {
        name,
        timezone: process.env.COMPANY_TIMEZONE?.trim() || 'America/Los_Angeles',
        shopLat: num(process.env.SHOP_LAT),
        shopLng: num(process.env.SHOP_LNG),
        shopRadiusM: num(process.env.SHOP_RADIUS_M) ?? 150,
      },
    })
    console.log(`Created company "${company.name}" (${company.timezone})`)
  } else {
    console.log(`Company "${company.name}" already exists`)
  }

  const admin = await prisma.person.findUnique({ where: { email } })
  if (!admin) {
    if (password.length < 10) throw new Error('Set ADMIN_PASSWORD (at least 10 characters) in server/.env')
    await prisma.person.create({
      data: {
        companyId: company.id,
        email,
        name: process.env.ADMIN_NAME?.trim() || email,
        role: 'admin',
        passwordHash: await bcrypt.hash(password, 12),
      },
    })
    console.log(`Created admin ${email}`)
  } else {
    console.log(`Admin ${email} already exists (password left as it is)`)
  }

  for (const [i, p] of PHASES.entries()) {
    await prisma.phase.upsert({
      where: { companyId_key: { companyId: company.id, key: p.key } },
      update: {},
      create: { companyId: company.id, ...p, sortOrder: (i + 1) * 10 },
    })
  }
  console.log(`Phases ready (${PHASES.length})`)

  if ((await prisma.job.count({ where: { companyId: company.id } })) === 0) {
    await prisma.job.createMany({
      data: [
        { companyId: company.id, kind: 'shop', name: 'Shop', code: 'SHOP' },
        { companyId: company.id, kind: 'service', name: 'Service call', code: 'SERVICE' },
      ],
    })
    console.log('Added jobs: Shop, Service call')
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
