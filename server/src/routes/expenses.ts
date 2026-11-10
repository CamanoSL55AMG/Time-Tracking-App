import { Router, type Request } from 'express'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { bool, requiredStr, route, str } from '../api.js'
import { badRequest, notFound } from '../errors.js'
import { requirePerson, requireScope } from '../auth/middleware.js'
import { SELF } from '../auth/apiKeys.js'
import { assertVisible, personIdFilter } from '../auth/division.js'
import type { Auth } from '../auth/middleware.js'
import { isYmd } from '../lib/time.js'
import {
  addExpense,
  attachReceipt,
  changeExpense,
  decideExpense,
  deleteExpense,
  expenseInclude,
  receiptFile,
  shape,
  totals,
  type ExpenseInput,
} from '../services/expenses.js'
import { addRecurring, changeRecurring, listRecurring, runRecurring, setRecurringStatus, shapeRecurring, type RecurringInput } from '../services/recurringExpenses.js'

export const expensesRouter = Router()

const KINDS = ['expense', 'mileage']

const money = (v: unknown, field: string): number | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  if (!Number.isFinite(n)) throw badRequest(`${field} must be a number.`, { field })
  return n
}

function inputOf(req: Request): ExpenseInput {
  const b = (req.body ?? {}) as Record<string, unknown>
  return {
    jobId: b.jobId === null ? null : b.jobId === undefined ? undefined : str(b.jobId, 80),
    currentFlight: bool(b.currentFlight),
    date: b.date === undefined ? undefined : str(b.date, 10),
    categoryId: str(b.categoryId, 80) || undefined,
    amount: money(b.amount, 'amount'),
    miles: money(b.miles, 'miles'),
    paidBy: b.paidBy === undefined ? undefined : str(b.paidBy, 20),
    vendor: b.vendor === undefined ? undefined : str(b.vendor, 200),
    notes: b.notes === undefined ? undefined : str(b.notes, 1000),
    draft: bool(b.draft),
    clientId: str(b.clientId, 80) || undefined,
  }
}

const EXPENSE_BODY = {
  currentFlight: 'true to charge it to the job you are clocked into right now',
  jobId: 'Job to charge (or null for no job). Ignored when currentFlight is true',
  date: 'YYYY-MM-DD, company time. Defaults to today',
  categoryId: 'Category (GET /expense-categories)',
  amount: 'Dollars. Not used for mileage categories',
  miles: 'Miles driven, for a mileage category; priced at the company mileage rate',
  paidBy: 'employee (to be reimbursed, default) or company_card',
  vendor: 'Where it was bought',
  notes: 'What it was for',
}

const rangeWhere = (q: Request['query']): Prisma.ExpenseWhereInput => {
  const from = str(q.from, 10)
  const to = str(q.to, 10)
  for (const [f, v] of [['from', from], ['to', to]] as const) if (v && !isYmd(v)) throw badRequest(`${f} must be YYYY-MM-DD.`, { field: f })
  return from || to ? { date: { gte: from || undefined, lte: to || undefined } } : {}
}

// ─── Categories ─────────────────────────────────────────────────────────────

route(
  expensesRouter,
  { method: 'get', path: '/expense-categories', tag: 'Expenses', summary: 'Expense categories, and the mileage rate in force.', access: [SELF, 'jobs:read', 'expenses:read'], query: { all: 'true to include switched-off ones' } },
  async (req) => {
    const auth = requireScope(req, SELF, 'jobs:read', 'expenses:read')
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const data = await prisma.expenseCategory.findMany({
      where: { companyId: auth.companyId, ...(req.query.all === 'true' ? {} : { active: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    })
    return { data, mileageRate: company.mileageRate, reimbursementAccountCode: company.reimbursementAccountCode ?? '' }
  },
)

route(
  expensesRouter,
  {
    method: 'post',
    path: '/expense-categories',
    tag: 'Expenses',
    summary: 'Add an expense category.',
    access: ['jobs:write'],
    status: 201,
    body: { name: 'Name', kind: 'expense (default) or mileage', accountCode: 'Accounting account it posts to' },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const b = req.body ?? {}
    const name = requiredStr(b.name, 'name', 80)
    const kind = b.kind === undefined ? 'expense' : String(b.kind)
    if (!KINDS.includes(kind)) throw badRequest('kind must be expense or mileage.', { field: 'kind' })
    if (await prisma.expenseCategory.findFirst({ where: { companyId: auth.companyId, name } })) throw badRequest(`"${name}" already exists.`, { field: 'name' })
    const last = await prisma.expenseCategory.findFirst({ where: { companyId: auth.companyId }, orderBy: { sortOrder: 'desc' } })
    const category = await prisma.expenseCategory.create({
      data: { companyId: auth.companyId, name, kind, accountCode: str(b.accountCode, 40), sortOrder: (last?.sortOrder ?? 0) + 10 },
    })
    return { category }
  },
)

route(
  expensesRouter,
  {
    method: 'patch',
    path: '/expense-categories/:id',
    tag: 'Expenses',
    summary: 'Rename a category, change its account code, or switch it off.',
    access: ['jobs:write'],
    body: { name: 'Name', accountCode: 'Account code', active: 'false hides it from new expenses' },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const existing = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!existing) throw notFound('Category')
    const b = req.body ?? {}
    const category = await prisma.expenseCategory.update({
      where: { id: existing.id },
      data: {
        name: b.name === undefined ? undefined : requiredStr(b.name, 'name', 80),
        accountCode: b.accountCode === undefined ? undefined : str(b.accountCode, 40),
        active: bool(b.active),
      },
    })
    return { category }
  },
)

route(
  expensesRouter,
  { method: 'patch', path: '/company/mileage-rate', tag: 'Expenses', summary: 'Set the mileage rate for new mileage lines.', access: ['jobs:write'], body: { mileageRate: 'Dollars per mile, e.g. 0.725' } },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const rate = Number(req.body?.mileageRate)
    if (!Number.isFinite(rate) || rate <= 0 || rate > 5) throw badRequest('mileageRate must be dollars per mile, more than 0.', { field: 'mileageRate' })
    const company = await prisma.company.update({ where: { id: auth.companyId }, data: { mileageRate: rate } })
    return { mileageRate: company.mileageRate }
  },
)

route(
  expensesRouter,
  {
    method: 'patch',
    path: '/company/expense-settings',
    tag: 'Expenses',
    summary: 'Expense settings: the mileage rate, and the account own-money lines post to.',
    access: ['jobs:write'],
    body: {
      mileageRate: 'Dollars per mile for new mileage lines, e.g. 0.725',
      reimbursementAccountCode: 'Account for lines paid with the employee\u2019s own money (mileage excepted). Empty = use each category\u2019s account',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const b = (req.body ?? {}) as Record<string, unknown>
    let mileageRate: number | undefined
    if (b.mileageRate !== undefined) {
      mileageRate = Number(b.mileageRate)
      if (!Number.isFinite(mileageRate) || mileageRate <= 0 || mileageRate > 5) throw badRequest('mileageRate must be dollars per mile, more than 0.', { field: 'mileageRate' })
    }
    const company = await prisma.company.update({
      where: { id: auth.companyId },
      data: { mileageRate, reimbursementAccountCode: b.reimbursementAccountCode === undefined ? undefined : str(b.reimbursementAccountCode, 40) },
    })
    return { mileageRate: company.mileageRate, reimbursementAccountCode: company.reimbursementAccountCode ?? '' }
  },
)

// ─── Your own expenses ──────────────────────────────────────────────────────

route(
  expensesRouter,
  { method: 'get', path: '/me/expenses', tag: 'Expenses', summary: 'Your expenses, newest first, with totals.', access: [SELF], query: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD, inclusive' } },
  async (req) => {
    const auth = requireScope(req, SELF)
    const person = requirePerson(auth)
    const rows = await prisma.expense.findMany({
      where: { companyId: auth.companyId, personId: person.id, ...rangeWhere(req.query) },
      include: expenseInclude,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    })
    return { data: rows.map(shape), totals: totals(rows) }
  },
)

route(
  expensesRouter,
  { method: 'post', path: '/me/expenses', tag: 'Expenses', summary: 'Add an expense or mileage line. It is submitted for approval unless draft is true.', access: [SELF], status: 201, body: { ...EXPENSE_BODY, draft: 'true to keep it for later instead of submitting', clientId: 'Id from the sender; re-sending it adds nothing' } },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    return { expense: shape(await addExpense(person, inputOf(req))) }
  },
)

route(
  expensesRouter,
  { method: 'patch', path: '/me/expenses/:id', tag: 'Expenses', summary: 'Change one of your expenses until it is approved. A rejected one goes back for approval.', access: [SELF], body: { ...EXPENSE_BODY, draft: 'false to submit a draft' } },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    return { expense: shape(await changeExpense(person, req.params.id, inputOf(req))) }
  },
)

route(
  expensesRouter,
  { method: 'delete', path: '/me/expenses/:id', tag: 'Expenses', summary: 'Remove one of your expenses until it is approved.', access: [SELF] },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    await deleteExpense(person, req.params.id)
    return { ok: true }
  },
)

route(
  expensesRouter,
  {
    method: 'post',
    path: '/me/expenses/:id/receipt',
    tag: 'Expenses',
    summary: 'Attach the receipt (photo or PDF, 6 MB at most), replacing any earlier one.',
    access: [SELF],
    body: { contentType: 'image/jpeg, image/png, image/webp or application/pdf', data: 'The file, base64-encoded' },
  },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    const b = (req.body ?? {}) as Record<string, unknown>
    if (typeof b.data !== 'string') throw badRequest('data must be the file, base64-encoded.', { field: 'data' })
    return { expense: shape(await attachReceipt(person, req.params.id, str(b.contentType, 60), b.data)) }
  },
)

route(
  expensesRouter,
  { method: 'get', path: '/expenses/:id/receipt', tag: 'Expenses', summary: 'The receipt file itself (not JSON). Yours, or anyone’s with expenses:read.', access: [SELF, 'expenses:read'], division: true },
  async (req, res) => {
    const auth = requireScope(req, SELF, 'expenses:read')
    await assertExpenseVisible(auth, req.params.id)
    const { file, type } = await receiptFile(auth.companyId, req.params.id, { personId: auth.person?.id ?? null, canReadAll: auth.scopes.has('expenses:read') })
    res.type(type)
    res.setHeader('Cache-Control', 'private, max-age=300')
    await new Promise<void>((resolve, reject) => res.sendFile(file, (err) => (err ? reject(notFound('Receipt file')) : resolve())))
  },
)

// ─── Everyone's expenses (managers, payroll, accounting) ───────────────────

route(
  expensesRouter,
  {
    method: 'get',
    path: '/expenses',
    tag: 'Expenses',
    summary: 'Expenses with totals. Accounting reads approved lines from here.',
    access: ['expenses:read'],
    query: { status: 'draft | submitted | approved | rejected', personId: 'Only this person', jobId: 'Only this job', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD, inclusive' },
    division: true,
  },
  async (req) => {
    const auth = requireScope(req, 'expenses:read')
    const status = str(req.query.status, 20)
    if (status && !['draft', 'submitted', 'approved', 'rejected'].includes(status)) throw badRequest('status must be draft, submitted, approved or rejected.', { field: 'status' })
    const onePerson = str(req.query.personId, 80) || undefined
    if (onePerson) await assertVisible(auth, onePerson)
    const rows = await prisma.expense.findMany({
      where: {
        companyId: auth.companyId,
        status: status || { not: 'draft' },
        personId: onePerson ?? (await personIdFilter(auth)),
        jobId: str(req.query.jobId, 80) || undefined,
        ...rangeWhere(req.query),
      },
      include: expenseInclude,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
      take: 2000,
    })
    return { data: rows.map(shape), totals: totals(rows) }
  },
)

for (const decision of ['approve', 'reject'] as const) {
  route(
    expensesRouter,
    {
      method: 'post',
      path: `/expenses/:id/${decision}`,
      tag: 'Expenses',
      summary: decision === 'approve' ? 'Approve an expense. Nobody approves their own.' : 'Reject an expense, saying why. The person can fix it and it comes back.',
      access: ['expenses:approve'],
      body: { note: decision === 'approve' ? 'Optional note' : 'Why it is rejected (required)' },
      division: true,
    },
    async (req) => {
      const auth = requireScope(req, 'expenses:approve')
      await assertExpenseVisible(auth, req.params.id)
      const e = await decideExpense({ companyId: auth.companyId, personId: auth.person?.id ?? null }, req.params.id, decision, str(req.body?.note, 500))
      return { expense: shape(e) }
    },
  )
}

// ─── Monthly repeats ────────────────────────────────────────────────────────

function recurringInputOf(req: Request): RecurringInput {
  const b = (req.body ?? {}) as Record<string, unknown>
  const day = b.dayOfMonth === undefined || b.dayOfMonth === null || b.dayOfMonth === '' ? undefined : Number(b.dayOfMonth)
  return {
    categoryId: str(b.categoryId, 80) || undefined,
    amount: money(b.amount, 'amount'),
    paidBy: b.paidBy === undefined ? undefined : str(b.paidBy, 20),
    vendor: b.vendor === undefined ? undefined : str(b.vendor, 200),
    notes: b.notes === undefined ? undefined : str(b.notes, 1000),
    jobId: b.jobId === null ? null : b.jobId === undefined ? undefined : str(b.jobId, 80),
    dayOfMonth: day,
    startMonth: b.startMonth === undefined ? undefined : str(b.startMonth, 7),
    endMonth: b.endMonth === null ? null : b.endMonth === undefined ? undefined : str(b.endMonth, 7),
  }
}

const RECURRING_BODY = {
  categoryId: 'Category (an amount category; mileage cannot repeat)',
  amount: 'Dollars each month',
  paidBy: 'employee (to be reimbursed, default) or company_card',
  vendor: 'Who it is paid to, e.g. T-Mobile',
  notes: 'What it is for',
  jobId: 'Job to charge each line to, or null for no job',
  dayOfMonth: '1-31: the day each month the line is added (a short month uses its last day)',
  endMonth: 'YYYY-MM, the last month; null or empty for no end',
}
/** A division admin reaches an expense by id only when it belongs to someone in their division. */
async function assertExpenseVisible(auth: Auth, id: string): Promise<void> {
  if (auth.division === null) return
  const e = await prisma.expense.findFirst({ where: { id, companyId: auth.companyId }, select: { personId: true } })
  await assertVisible(auth, e?.personId, 'Expense')
}

const made = (lines: Awaited<ReturnType<typeof runRecurring>>) => lines.map(shape)

route(
  expensesRouter,
  { method: 'get', path: '/me/recurring-expenses', tag: 'Expenses', summary: 'Your monthly repeats (stopped ones only with all=true).', access: [SELF], query: { all: 'true to include stopped ones' } },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    const rows = await listRecurring(person.companyId, person.id, req.query.all === 'true')
    return { data: rows.map(shapeRecurring) }
  },
)

route(
  expensesRouter,
  {
    method: 'post',
    path: '/me/recurring-expenses',
    tag: 'Expenses',
    summary: 'Set up a monthly repeat. On its day each month it adds a submitted expense line for approval. If this month’s day has come, this month’s line is added now.',
    access: [SELF],
    status: 201,
    body: { ...RECURRING_BODY, startMonth: 'YYYY-MM, this month (default) or later' },
  },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    const r = await addRecurring(person, recurringInputOf(req))
    return { recurring: shapeRecurring(r.recurring), added: made(r.made) }
  },
)

route(
  expensesRouter,
  { method: 'patch', path: '/me/recurring-expenses/:id', tag: 'Expenses', summary: 'Change a monthly repeat for the months to come. Lines already added stay as they are.', access: [SELF], body: RECURRING_BODY },
  async (req) => {
    const person = requirePerson(requireScope(req, SELF))
    const r = await changeRecurring(person, req.params.id, recurringInputOf(req))
    return { recurring: shapeRecurring(r.recurring), added: made(r.made) }
  },
)

for (const action of ['pause', 'resume', 'stop'] as const) {
  route(
    expensesRouter,
    {
      method: 'post',
      path: `/me/recurring-expenses/:id/${action}`,
      tag: 'Expenses',
      summary: {
        pause: 'Pause a monthly repeat. No lines are added while it is paused, and those months are skipped.',
        resume: 'Start a paused repeat again, from this month on.',
        stop: 'Stop a monthly repeat for good. Lines already added stay.',
      }[action],
      access: [SELF],
    },
    async (req) => {
      const person = requirePerson(requireScope(req, SELF))
      const r = await setRecurringStatus(person, req.params.id, action)
      return { recurring: shapeRecurring(r.recurring), added: made(r.made) }
    },
  )
}

route(
  expensesRouter,
  { method: 'get', path: '/recurring-expenses', tag: 'Expenses', summary: 'Everyone’s monthly repeats.', access: ['expenses:read'], query: { personId: 'Only this person', all: 'true to include stopped ones' }, division: true },
  async (req) => {
    const auth = requireScope(req, 'expenses:read')
    const onePerson = str(req.query.personId, 80) || undefined
    if (onePerson) await assertVisible(auth, onePerson)
    const rows = await listRecurring(auth.companyId, onePerson ?? (await personIdFilter(auth)), req.query.all === 'true')
    return { data: rows.map(shapeRecurring) }
  },
)

route(
  expensesRouter,
  {
    method: 'post',
    path: '/recurring-expenses/run',
    tag: 'Expenses',
    summary: 'Add any monthly repeat lines that are due now. The server does this on its own every hour; running it again never adds a month twice.',
    access: ['jobs:write'],
  },
  async (req) => {
    const auth = requireScope(req, 'jobs:write')
    const lines = await runRecurring({ companyId: auth.companyId })
    return { added: made(lines) }
  },
)
