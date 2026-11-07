// Set up a monthly repeating expense for one person from the server's command line,
// the same as "Add monthly repeat" on the phone's Expenses screen.
//
// Dry run by default: it prints what it would do and changes nothing. Add --apply to
// create it. If the day has already come this month, this month's line is added at
// once and goes to the office for approval like any other line.
//
//   npm run recurring:add -- --email you@example.com --amount 40 --vendor "T-Mobile" \
//     --notes "Work cell phone" --category "Other" --day 1
//   npm run recurring:add -- ...same... --apply
//
// Options: --email (required), --amount (required), --vendor, --notes, --category
// (name, default "Other"), --day (1-31, default 1), --start YYYY-MM (default this
// month), --end YYYY-MM, --company-card (default: paid with own money, reimbursed).
import 'dotenv/config'
import { prisma } from '../src/db.js'
import { localDate } from '../src/lib/time.js'
import { addRecurring, ordinal } from '../src/services/recurringExpenses.js'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string): string | undefined => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--') ? args[i + 1] : undefined
}
const fail = (msg: string): never => {
  console.error(`\nNot done: ${msg}`)
  process.exit(1)
}

async function main() {
  const email = (opt('email') ?? '').trim().toLowerCase()
  if (!email) fail('give --email, the address the person signs in to Logbook with.')
  const amount = Number(opt('amount'))
  if (!Number.isFinite(amount) || amount <= 0) fail('give --amount in dollars, e.g. --amount 40')
  const day = Number(opt('day') ?? 1)
  const categoryName = opt('category') ?? 'Other'
  const apply = flag('apply')

  const person = await prisma.person.findUnique({ where: { email } })
  if (!person || !person.active) {
    const near = await prisma.person.findMany({ where: { active: true, email: { contains: email.split('@')[0].slice(0, 4), mode: 'insensitive' } }, select: { email: true, name: true }, take: 10 })
    fail(`no active person with the email ${email}.${near.length ? ` Close matches: ${near.map((p) => `${p.name} <${p.email}>`).join(', ')}` : ''}`)
  }
  const p = person!
  const categories = await prisma.expenseCategory.findMany({ where: { companyId: p.companyId, active: true, kind: 'expense' }, orderBy: { sortOrder: 'asc' } })
  const category = categories.find((c) => c.name.toLowerCase() === categoryName.toLowerCase())
  if (!category) fail(`no category called "${categoryName}". Pick one of: ${categories.map((c) => `"${c.name}"`).join(', ')}`)

  const company = await prisma.company.findUniqueOrThrow({ where: { id: p.companyId } })
  const today = localDate(new Date(), company.timezone)
  const vendor = opt('vendor') ?? ''
  const same = await prisma.recurringExpense.findFirst({
    where: { personId: p.id, status: { not: 'stopped' }, amountCents: Math.round(amount * 100), vendor: { equals: vendor, mode: 'insensitive' } },
  })
  if (same) fail(`${p.name} already has this repeat (${vendor || category!.name}, $${amount.toFixed(2)}, ${same.status}). Change it on the phone's Expenses screen instead.`)

  const input = {
    categoryId: category!.id,
    amount,
    paidBy: flag('company-card') ? 'company_card' : 'employee',
    vendor,
    notes: opt('notes') ?? '',
    dayOfMonth: day,
    startMonth: opt('start') ?? today.slice(0, 7),
    endMonth: opt('end') ?? null,
  }
  console.log(`\nMonthly repeat for ${p.name} <${p.email}>`)
  console.log(`  ${input.vendor || category!.name}: $${amount.toFixed(2)} on the ${ordinal(day)} of each month, from ${input.startMonth}${input.endMonth ? ` through ${input.endMonth}` : ' until stopped'}`)
  console.log(`  Category ${category!.name}; ${input.paidBy === 'employee' ? 'own money, reimbursed' : 'company card'}; no job${input.notes ? `; "${input.notes}"` : ''}`)

  if (!apply) {
    console.log('\nDry run: nothing was changed. Run the same command with --apply to create it.')
    return
  }
  const r = await addRecurring(p, input)
  console.log(`\nCreated. ${r.made.length ? `Added ${r.made.length} line${r.made.length === 1 ? '' : 's'} (${r.made.map((e) => e.date).join(', ')}), waiting for approval.` : 'The first line is added when its day comes.'}`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
