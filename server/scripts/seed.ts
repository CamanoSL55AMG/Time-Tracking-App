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
  // Office work. Picked directly, not stepped through with "Next"; each rolls up to
  // its own sold-labor line.
  { key: 'engineering', name: 'Engineering / design', short: 'Engineering', atShop: false, laborCategory: 'engineering', dayFlow: false },
  { key: 'programming', name: 'Programming', short: 'Programming', atShop: false, laborCategory: 'programming', dayFlow: false },
  { key: 'project-management', name: 'Project management', short: 'PM', atShop: false, laborCategory: 'management', dayFlow: false },
]

const LEAVE_TYPES = [
  { key: 'sick', name: 'Sick leave', paid: true, drawsBalance: true, statutory: 'wa_sick' },
  { key: 'vacation', name: 'Vacation', paid: true, drawsBalance: true, statutory: 'none' },
  { key: 'holiday', name: 'Holiday', paid: true, drawsBalance: false, statutory: 'none' },
  { key: 'bereavement', name: 'Bereavement', paid: true, drawsBalance: false, statutory: 'none' },
  { key: 'jury-duty', name: 'Jury duty', paid: true, drawsBalance: false, statutory: 'none' },
  { key: 'unpaid', name: 'Unpaid leave', paid: false, drawsBalance: false, statutory: 'none' },
  // A state insurance program: recorded so nobody expects punches; no balance here.
  { key: 'wa-pfml', name: 'WA Paid Family & Medical Leave', paid: false, drawsBalance: false, statutory: 'wa_pfml' },
]

// Account codes are left for finance to fill in under Manage → Expenses.
const EXPENSE_CATEGORIES = [
  { name: 'Fuel', mileage: false },
  { name: 'Materials & parts', mileage: false },
  { name: 'Tools', mileage: false },
  { name: 'Meals', mileage: false },
  { name: 'Lodging', mileage: false },
  { name: 'Parking & tolls', mileage: false },
  { name: 'Mileage (own vehicle)', mileage: true },
  { name: 'Other', mileage: false },
]

// IRS business standard mileage rates, in tenths of a cent.
const MILEAGE_RATES = [
  { effectiveFrom: '2025-01-01', rateMills: 700, note: 'IRS business rate 2025: 70¢' },
  { effectiveFrom: '2026-01-01', rateMills: 725, note: 'IRS business rate 2026: 72.5¢' },
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

  // Kinds of leave. Sick leave and vacation are separate banks (decided 2026-10-07).
  for (const [i, t] of LEAVE_TYPES.entries()) {
    await prisma.leaveType.upsert({
      where: { companyId_key: { companyId: company.id, key: t.key } },
      update: {},
      create: { companyId: company.id, ...t, sortOrder: (i + 1) * 10 },
    })
  }
  console.log(`Leave types ready (${LEAVE_TYPES.length})`)

  // Washington paid sick leave, for everyone: 1 hour per 40 worked, usable from day
  // 90, up to 40 hours carried into the next year (L&I, read 2026-10-07). Vacation
  // has no default: it is set per person under Manage → Leave.
  const sick = await prisma.leaveType.findUniqueOrThrow({ where: { companyId_key: { companyId: company.id, key: 'sick' } } })
  if (!(await prisma.leavePolicy.findFirst({ where: { companyId: company.id, leaveTypeId: sick.id } }))) {
    await prisma.leavePolicy.create({
      data: {
        companyId: company.id,
        leaveTypeId: sick.id,
        name: 'Washington paid sick leave',
        method: 'per_hours_worked',
        rateHours: 1,
        perHours: 40,
        carryoverMax: 40,
        waitingDays: 90,
        appliesToAll: true,
      },
    })
    console.log('Added policy: Washington paid sick leave (everyone)')
  }

  for (const [i, c] of EXPENSE_CATEGORIES.entries()) {
    await prisma.expenseCategory.upsert({
      where: { companyId_name: { companyId: company.id, name: c.name } },
      update: {},
      create: { companyId: company.id, ...c, sortOrder: (i + 1) * 10 },
    })
  }
  console.log(`Expense categories ready (${EXPENSE_CATEGORIES.length})`)

  for (const r of MILEAGE_RATES) {
    await prisma.mileageRate.upsert({
      where: { companyId_effectiveFrom: { companyId: company.id, effectiveFrom: r.effectiveFrom } },
      update: {},
      create: { companyId: company.id, ...r },
    })
  }
  console.log('Mileage rates ready')

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
