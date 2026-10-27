// One-time setup: the company, the first admin, the phases of the day and two
// standing jobs. Safe to run again; it only adds what is missing.
//   npm run seed
import 'dotenv/config'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

// mode = the work mode on the start screen the phase belongs to (install, service,
// office, shop, cad). "Next" walks the field-day steps (dayFlow) of one mode only.
const PHASES = [
  // Install: the field day, walked with "Next".
  { key: 'shop-load', name: 'Shop — load vans', short: 'Load', atShop: true, mode: 'install' },
  { key: 'travel-out', name: 'Drive to site', short: 'Drive out', atShop: false, mode: 'install' },
  { key: 'unload', name: 'Unload at site', short: 'Unload', atShop: false, mode: 'install' },
  { key: 'work', name: 'Work on project', short: 'Work', atShop: false, mode: 'install' },
  { key: 'cleanup', name: 'Clean up', short: 'Clean up', atShop: false, mode: 'install' },
  { key: 'travel-back', name: 'Drive to shop', short: 'Drive back', atShop: false, mode: 'install' },
  { key: 'shop-unload', name: 'Shop — unload / put away', short: 'Put away', atShop: true, mode: 'install' },
  // Office work. Picked directly, not stepped through with "Next"; each rolls up to
  // its own sold-labor line. Admin / overhead is where unallocated time goes.
  { key: 'engineering', name: 'Engineering / design', short: 'Engineering', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'office' },
  { key: 'programming', name: 'Programming', short: 'Programming', atShop: false, laborCategory: 'programming', dayFlow: false, mode: 'office' },
  { key: 'project-management', name: 'Project management', short: 'PM', atShop: false, laborCategory: 'management', dayFlow: false, mode: 'office' },
  { key: 'admin-overhead', name: 'Admin / overhead', short: 'Overhead', atShop: false, laborCategory: 'other', dayFlow: false, mode: 'office' },
  // Service calls: Drive → On site, then on to the next call. A parts stop is
  // picked directly during a drive.
  { key: 'svc-travel', name: 'Drive to call', short: 'Drive', atShop: false, laborCategory: 'service', dayFlow: true, mode: 'service' },
  { key: 'svc-onsite', name: 'On site — service call', short: 'On site', atShop: false, laborCategory: 'service', dayFlow: true, mode: 'service' },
  { key: 'svc-parts', name: 'Parts / supply stop', short: 'Parts stop', atShop: false, laborCategory: 'service', dayFlow: false, mode: 'service' },
  // Drive home from the last call: paid time, never billed to the customer.
  { key: 'svc-home', name: 'Drive home', short: 'Drive home', atShop: false, laborCategory: 'service', dayFlow: false, mode: 'service' },
  // Shop tasks, clocked in and out through the day against a project.
  { key: 'shop-uci', name: 'UCI building', short: 'UCI', atShop: true, laborCategory: 'install', dayFlow: false, mode: 'shop' },
  { key: 'shop-rack', name: 'Rack building', short: 'Racks', atShop: true, laborCategory: 'install', dayFlow: false, mode: 'shop' },
  { key: 'shop-prep', name: 'Prepping parts', short: 'Prep', atShop: true, laborCategory: 'install', dayFlow: false, mode: 'shop' },
  { key: 'shop-receiving', name: 'Receiving — unload boxes, populate racks', short: 'Receiving', atShop: true, laborCategory: 'install', dayFlow: false, mode: 'shop' },
  { key: 'shop-general', name: 'Shop — general / clean up', short: 'Shop', atShop: true, laborCategory: 'other', dayFlow: false, mode: 'shop' },
  // CAD team: the standard drafting tasks, picked directly against a project and
  // rolled up to Engineering. Edit or add more under Manage → Phases (mode CAD).
  { key: 'cad-design', name: 'CAD — System design drawings', short: 'Design', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
  { key: 'cad-signal-flow', name: 'CAD — Signal flow / line diagrams', short: 'Signal flow', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
  { key: 'cad-floor-plans', name: 'CAD — Floor plans / device layouts', short: 'Floor plans', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
  { key: 'cad-rack-elevations', name: 'CAD — Rack elevations', short: 'Racks', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
  { key: 'cad-submittals', name: 'CAD — Shop drawings / submittals', short: 'Submittals', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
  { key: 'cad-cable-schedules', name: 'CAD — Cable schedules / labels', short: 'Cable sched.', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
  { key: 'cad-revisions', name: 'CAD — Revisions / redlines', short: 'Revisions', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
  { key: 'cad-as-builts', name: 'CAD — As-built / record drawings', short: 'As-builts', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
  { key: 'cad-plotting', name: 'CAD — Plotting / printing', short: 'Plotting', atShop: false, laborCategory: 'engineering', dayFlow: false, mode: 'cad' },
]

const OVERHEAD_CODE = 'OVERHEAD'

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

  // Existing phases keep their names and order; only their work mode is set, so
  // databases seeded before modes existed pick them up.
  for (const [i, p] of PHASES.entries()) {
    await prisma.phase.upsert({
      where: { companyId_key: { companyId: company.id, key: p.key } },
      update: { mode: p.mode },
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

  // Expense categories and the AccountEdge expense account each one posts to (Morgan
  // Sound's account list from finance, 2026-10-05). New categories are added; an
  // existing one keeps any account code someone already set under Manage.
  const CATEGORIES = [
    { name: 'Materials / parts', kind: 'expense', accountCode: '6-1220' }, // Install Expense
    { name: 'Tools', kind: 'expense', accountCode: '6-1290' }, // Shop Expense
    { name: 'Fuel', kind: 'expense', accountCode: '6-1150' }, // Fuel
    { name: 'Mileage (own vehicle)', kind: 'mileage', accountCode: '6-1100', was: '6-1190' }, // Truck and Auto
    { name: 'Parking / tolls', kind: 'expense', accountCode: '6-1190' }, // Travel
    { name: 'Meals', kind: 'expense', accountCode: '6-1160' }, // Food
    { name: 'Per diem', kind: 'expense', accountCode: '6-1180' }, // Per Diems
    { name: 'Lodging', kind: 'expense', accountCode: '6-1170' }, // Lodging
    { name: 'Equipment rental', kind: 'expense', accountCode: '6-1210' }, // Equipment Rental
    { name: 'Permits / licenses', kind: 'expense', accountCode: '6-1090' }, // License and Permit Fees
    { name: 'Shipping', kind: 'expense', accountCode: '6-1120' }, // Shipping
    { name: 'Office supplies', kind: 'expense', accountCode: '6-1300' }, // Office Supplies
    { name: 'Other', kind: 'expense', accountCode: '6-1250' }, // Misc Expense
  ]
  let addedCats = 0
  for (const [i, c] of CATEGORIES.entries()) {
    const existing = await prisma.expenseCategory.findUnique({ where: { companyId_name: { companyId: company.id, name: c.name } } })
    const { was, ...data } = c as typeof c & { was?: string }
    if (!existing) {
      await prisma.expenseCategory.create({ data: { companyId: company.id, ...data, sortOrder: (i + 1) * 10 } })
      addedCats += 1
    } else {
      // Keep the list in this order ("Other" last), and fill a missing account code.
      await prisma.expenseCategory.update({
        where: { id: existing.id },
        // A code still at an earlier default moves to the current one (mileage: 6-1190 → 6-1100).
        data: { sortOrder: (i + 1) * 10, ...(!existing.accountCode || existing.accountCode === was ? { accountCode: c.accountCode } : {}) },
      })
    }
  }
  // Own-money lines (mileage excepted) post to Employee Business Expense. Set once;
  // clearing it under Manage turns it off and the seed leaves that alone.
  if (company.reimbursementAccountCode === null) {
    await prisma.company.update({ where: { id: company.id }, data: { reimbursementAccountCode: '6-1140' } })
    console.log('Reimbursed expenses post to 6-1140')
  }
  console.log(`Expense categories ready (${CATEGORIES.length}${addedCats ? `, ${addedCats} added` : ''})`)

  // Where time goes when someone stops a project but stays on the clock.
  if (!(await prisma.job.findFirst({ where: { companyId: company.id, code: OVERHEAD_CODE } }))) {
    await prisma.job.create({ data: { companyId: company.id, kind: 'other', name: 'Unallocated / overhead', code: OVERHEAD_CODE } })
    console.log('Added job: Unallocated / overhead')
  }
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
