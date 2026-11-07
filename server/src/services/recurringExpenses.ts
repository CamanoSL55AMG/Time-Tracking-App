import { Prisma, type Person, type RecurringExpense } from '@prisma/client'
import { prisma } from '../db.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { localDate } from '../lib/time.js'
import { emit } from './events.js'
import { expenseInclude, PAID_BY, type ExpenseRow } from './expenses.js'

// Monthly repeats. A person who pays the same bill every month (a phone plan, say)
// sets it up once. On its day each month the app adds a normal Expense line with
// status "submitted", so it goes through the same approval as any other line and
// nobody approves their own. Pausing skips the months it is paused; stopping is for
// good. A repeat line needs no receipt: the line says it is a monthly repeat.
//
// Safe to run again and again: each month made is recorded in RecurringExpenseRun,
// whose key (repeat, month) refuses a second insert. A restart, two runs at once, or
// a line removed by hand never brings a month back.

const MAX_CENTS = 10_000_00
/** Months a repeat catches up on after the server was off; older ones are left. */
const MAX_CATCH_UP = 12

export const isYm = (s: string): boolean => /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

/** Whole months added to a YYYY-MM month. */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number)
  const d = new Date(Date.UTC(y, m - 1 + n, 1))
  return d.toISOString().slice(0, 7)
}

export function daysInMonth(ym: string): number {
  const [y, m] = ym.split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).getUTCDate()
}

/** The line's date in that month: the repeat's day, or the month's last day when shorter. */
export function lineDate(ym: string, dayOfMonth: number): string {
  const day = Math.min(Math.max(1, dayOfMonth), daysInMonth(ym))
  return `${ym}-${String(day).padStart(2, '0')}`
}

/**
 * Months whose line is due by `today` (YYYY-MM-DD, company time) and not made yet,
 * oldest first. Never a month before `startMonth`, after `endMonth`, or whose day has
 * not come; at most the last MAX_CATCH_UP months.
 */
export function dueMonths(
  t: { startMonth: string; endMonth: string | null; dayOfMonth: number },
  today: string,
  made: ReadonlySet<string>,
): { month: string; date: string }[] {
  const thisMonth = today.slice(0, 7)
  let month = t.startMonth > addMonths(thisMonth, -(MAX_CATCH_UP - 1)) ? t.startMonth : addMonths(thisMonth, -(MAX_CATCH_UP - 1))
  const out: { month: string; date: string }[] = []
  while (month <= thisMonth) {
    if (t.endMonth && month > t.endMonth) break
    const date = lineDate(month, t.dayOfMonth)
    if (date <= today && !made.has(month)) out.push({ month, date })
    month = addMonths(month, 1)
  }
  return out
}

/** "1st", "2nd", "23rd", "31st". */
export function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'
  return `${n}${s}`
}

// ─── Shape ──────────────────────────────────────────────────────────────────

export const recurringInclude = {
  job: { select: { id: true, name: true, code: true, kind: true } },
  category: { select: { id: true, name: true, kind: true, accountCode: true } },
  person: { select: { id: true, name: true, email: true } },
} satisfies Prisma.RecurringExpenseInclude
export type RecurringRow = Prisma.RecurringExpenseGetPayload<{ include: typeof recurringInclude }>

export const shapeRecurring = (r: RecurringRow) => ({
  ...r,
  amount: r.amountCents / 100,
  schedule: `On the ${ordinal(r.dayOfMonth)} of each month${r.endMonth ? `, through ${r.endMonth}` : ''}`,
})

// ─── Input ──────────────────────────────────────────────────────────────────

export interface RecurringInput {
  categoryId?: string
  amount?: number
  paidBy?: string
  vendor?: string
  notes?: string
  jobId?: string | null
  dayOfMonth?: number
  startMonth?: string
  /** YYYY-MM, or null / "" for no end. */
  endMonth?: string | null
}

async function companyToday(companyId: string): Promise<string> {
  const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
  return localDate(new Date(), company.timezone)
}

async function checked(person: Person, input: RecurringInput, existing?: RecurringExpense) {
  const categoryId = input.categoryId ?? existing?.categoryId
  if (!categoryId) throw badRequest('Pick a category.', { field: 'categoryId' })
  const category = await prisma.expenseCategory.findFirst({ where: { id: categoryId, companyId: person.companyId } })
  if (!category) throw notFound('Category')
  if (!category.active && category.id !== existing?.categoryId) throw conflict('category_inactive', `${category.name} is no longer used.`)
  if (category.kind === 'mileage') throw badRequest('Mileage cannot repeat monthly. Pick an amount category.', { field: 'categoryId' })

  const amount = input.amount ?? (existing ? existing.amountCents / 100 : undefined)
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) throw badRequest('Enter the amount (more than 0).', { field: 'amount' })
  const amountCents = Math.round(amount * 100)
  if (amountCents > MAX_CENTS) throw badRequest('One line cannot be more than $10,000.', { field: 'amount' })

  if (input.paidBy !== undefined && !(PAID_BY as readonly string[]).includes(input.paidBy)) throw badRequest('paidBy must be employee or company_card.', { field: 'paidBy' })

  const dayOfMonth = input.dayOfMonth ?? existing?.dayOfMonth
  if (dayOfMonth === undefined || !Number.isInteger(dayOfMonth) || dayOfMonth < 1 || dayOfMonth > 31) throw badRequest('dayOfMonth must be a whole number from 1 to 31.', { field: 'dayOfMonth' })

  let jobId: string | null | undefined
  if (input.jobId === null || input.jobId === '') jobId = null
  else if (input.jobId !== undefined) {
    const job = await prisma.job.findFirst({ where: { id: input.jobId, companyId: person.companyId } })
    if (!job) throw notFound('Job')
    jobId = job.id
  }

  const today = await companyToday(person.companyId)
  const thisMonth = today.slice(0, 7)
  let startMonth = existing?.startMonth
  if (!existing) {
    startMonth = input.startMonth || thisMonth
    if (!isYm(startMonth)) throw badRequest('startMonth must be YYYY-MM.', { field: 'startMonth' })
    if (startMonth < thisMonth) throw badRequest('A repeat starts this month or later. Add an earlier month as a single expense.', { field: 'startMonth' })
  }
  let endMonth: string | null | undefined
  if (input.endMonth === null || input.endMonth === '') endMonth = null
  else if (input.endMonth !== undefined) {
    if (!isYm(input.endMonth)) throw badRequest('endMonth must be YYYY-MM.', { field: 'endMonth' })
    if (input.endMonth < startMonth!) throw badRequest('The last month cannot be before the first.', { field: 'endMonth' })
    endMonth = input.endMonth
  }
  return { category, amountCents, dayOfMonth, jobId, startMonth: startMonth!, endMonth }
}

async function own(person: Person, id: string): Promise<RecurringExpense> {
  const r = await prisma.recurringExpense.findFirst({ where: { id, companyId: person.companyId } })
  if (!r) throw notFound('Monthly repeat')
  if (r.personId !== person.id) throw forbidden('That is not your monthly repeat.')
  return r
}

// ─── Changes from the person ────────────────────────────────────────────────

export async function listRecurring(companyId: string, personId?: string, includeStopped = false) {
  return prisma.recurringExpense.findMany({
    where: { companyId, personId, ...(includeStopped ? {} : { status: { not: 'stopped' } }) },
    include: recurringInclude,
    orderBy: [{ status: 'asc' }, { createdAt: 'asc' }],
  })
}

/** Set one up. If this month's day has already come, this month's line is added now. */
export async function addRecurring(person: Person, input: RecurringInput) {
  const v = await checked(person, input)
  const r = await prisma.recurringExpense.create({
    data: {
      companyId: person.companyId,
      personId: person.id,
      categoryId: v.category.id,
      jobId: v.jobId ?? null,
      amountCents: v.amountCents,
      paidBy: input.paidBy ?? 'employee',
      vendor: input.vendor ?? '',
      notes: input.notes ?? '',
      dayOfMonth: v.dayOfMonth,
      startMonth: v.startMonth,
      endMonth: v.endMonth ?? null,
    },
  })
  const made = await runRecurring({ id: r.id })
  return { recurring: await prisma.recurringExpense.findUniqueOrThrow({ where: { id: r.id }, include: recurringInclude }), made }
}

/** Change it for the months to come. Lines already added stay as they are. */
export async function changeRecurring(person: Person, id: string, input: RecurringInput) {
  const existing = await own(person, id)
  if (existing.status === 'stopped') throw conflict('recurring_stopped', 'This repeat is stopped. Set up a new one.')
  const v = await checked(person, input, existing)
  await prisma.recurringExpense.update({
    where: { id: existing.id },
    data: {
      categoryId: v.category.id,
      jobId: v.jobId,
      amountCents: v.amountCents,
      paidBy: input.paidBy,
      vendor: input.vendor,
      notes: input.notes,
      dayOfMonth: v.dayOfMonth,
      endMonth: v.endMonth,
    },
  })
  const made = existing.status === 'active' ? await runRecurring({ id: existing.id }) : []
  return { recurring: await prisma.recurringExpense.findUniqueOrThrow({ where: { id: existing.id }, include: recurringInclude }), made }
}

/**
 * pause: no lines while paused, and the months it was paused are skipped for good.
 * resume: lines start again from this month. stop: for good.
 */
export async function setRecurringStatus(person: Person, id: string, action: 'pause' | 'resume' | 'stop') {
  const existing = await own(person, id)
  if (existing.status === 'stopped') throw conflict('recurring_stopped', 'This repeat is already stopped.')
  let data: Prisma.RecurringExpenseUpdateInput
  if (action === 'pause') data = { status: 'paused' }
  else if (action === 'stop') data = { status: 'stopped' }
  else {
    const thisMonth = (await companyToday(person.companyId)).slice(0, 7)
    data = { status: 'active', startMonth: existing.startMonth > thisMonth ? existing.startMonth : thisMonth }
  }
  await prisma.recurringExpense.update({ where: { id: existing.id }, data })
  const made = action === 'resume' ? await runRecurring({ id: existing.id }) : []
  return { recurring: await prisma.recurringExpense.findUniqueOrThrow({ where: { id: existing.id }, include: recurringInclude }), made }
}

// ─── The monthly run ────────────────────────────────────────────────────────

const isDuplicate = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002'

/**
 * Add every line that is due and not made yet: for one repeat (`id`), one company, or
 * all active repeats of active people. Returns the lines it added.
 */
export async function runRecurring(only: { id?: string; companyId?: string } = {}, now = new Date()): Promise<ExpenseRow[]> {
  const repeats = await prisma.recurringExpense.findMany({
    where: { id: only.id, companyId: only.companyId, status: 'active', person: { active: true } },
    include: { company: { select: { timezone: true } }, category: { select: { active: true, name: true } }, runs: { select: { month: true } } },
  })
  const added: ExpenseRow[] = []
  for (const r of repeats) {
    // A switched-off category waits until it is back on or the repeat is changed.
    if (!r.category.active) continue
    const today = localDate(now, r.company.timezone)
    for (const due of dueMonths(r, today, new Set(r.runs.map((x) => x.month)))) {
      try {
        const line = await prisma.$transaction(async (tx) => {
          // The run row first. ON CONFLICT DO NOTHING: when another run already made
          // this month (or is making it right now), nothing is inserted and we stop.
          const claimed = await tx.recurringExpenseRun.createMany({ data: [{ recurringExpenseId: r.id, month: due.month }], skipDuplicates: true })
          if (claimed.count === 0) return null
          const e = await tx.expense.create({
            data: {
              companyId: r.companyId,
              personId: r.personId,
              jobId: r.jobId,
              date: due.date,
              categoryId: r.categoryId,
              amountCents: r.amountCents,
              paidBy: r.paidBy,
              vendor: r.vendor,
              notes: r.notes,
              status: 'submitted',
              submittedAt: new Date(),
              recurringExpenseId: r.id,
            },
            include: expenseInclude,
          })
          await tx.recurringExpenseRun.update({ where: { recurringExpenseId_month: { recurringExpenseId: r.id, month: due.month } }, data: { expenseId: e.id } })
          await tx.recurringExpense.update({ where: { id: r.id }, data: { lastMonth: r.lastMonth && r.lastMonth > due.month ? r.lastMonth : due.month } })
          await emit(tx, r.companyId, 'expense.submitted', {
            expense: { id: e.id, personId: e.personId, jobId: e.jobId, jobCode: e.job?.code ?? null, date: e.date, category: e.category.name, amount: e.amountCents / 100, paidBy: e.paidBy, status: e.status },
            recurring: { id: r.id, month: due.month },
          })
          return e
        })
        if (line) added.push(line)
      } catch (err) {
        if (isDuplicate(err)) continue // another run made this month first
        throw err
      }
    }
  }
  return added
}

let running = false

/** Check for due lines shortly after start-up, then every `minutes`. 0 = off. */
export function startRecurringExpenses(minutes: number): void {
  if (minutes <= 0) {
    console.log('[repeats] RECURRING_EXPENSES_CHECK_MINUTES=0: monthly repeats are not added automatically.')
    return
  }
  const tick = async () => {
    if (running) return
    running = true
    try {
      const added = await runRecurring()
      if (added.length) console.log(`[repeats] Added ${added.length} monthly repeat line${added.length === 1 ? '' : 's'}.`)
    } catch (err) {
      console.error('[repeats] Monthly repeat run failed:', err)
    } finally {
      running = false
    }
  }
  setTimeout(() => void tick(), 10_000).unref()
  setInterval(() => void tick(), minutes * 60_000).unref()
}
