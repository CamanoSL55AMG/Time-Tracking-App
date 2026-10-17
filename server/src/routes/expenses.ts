import express, { Router, type Request } from 'express'
import type { Person, Prisma } from '@prisma/client'
import { prisma, type Tx } from '../db.js'
import { bool, limitOf, requiredStr, route, str } from '../api.js'
import { ApiError, badRequest, conflict, forbidden, notFound } from '../errors.js'
import { requireAuth, requirePerson, requireScope, type Auth } from '../auth/middleware.js'
import { KEYS_MANAGE, SELF } from '../auth/apiKeys.js'
import { centsPerMileToMills, mileageCents, toCents } from '../lib/money.js'
import { isYmd } from '../lib/time.js'
import { emit } from '../services/events.js'

// Expenses and mileage against jobs. A person enters lines on the phone, then
// submits them as one report; a manager approves or sends it back. Approved lines
// are locked. Every line carries a job, so expenses per job sit next to labor.

export const expensesRouter = Router()

const PAID_BY = ['employee', 'company']
const EDITABLE = ['draft', 'rejected']
const RECEIPT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
const RECEIPT_MAX = 10 * 1024 * 1024

const lineInclude = {
  category: true,
  job: { select: { id: true, name: true, code: true, kind: true } },
  person: { select: { id: true, name: true, email: true } },
  report: { select: { id: true, status: true, title: true } },
  receipt: { select: { id: true, mimeType: true, bytes: true } },
} satisfies Prisma.ExpenseInclude

type Line = Prisma.ExpenseGetPayload<{ include: typeof lineInclude }>

const lineView = (e: Line) => ({
  id: e.id,
  personId: e.personId,
  person: e.person,
  date: e.date,
  category: { id: e.category.id, name: e.category.name, mileage: e.category.mileage, accountCode: e.category.accountCode },
  job: e.job,
  amountCents: e.amountCents,
  miles: e.miles,
  rateMills: e.rateMills,
  paidBy: e.paidBy,
  vendor: e.vendor,
  notes: e.notes,
  reportId: e.reportId,
  status: e.report?.status ?? 'draft',
  editable: !e.report || EDITABLE.includes(e.report.status),
  receipt: e.receipt ? { mimeType: e.receipt.mimeType, bytes: e.receipt.bytes } : null,
  createdAt: e.createdAt,
  updatedAt: e.updatedAt,
})

const isAdmin = (auth: Auth) => auth.scopes.has(KEYS_MANAGE)

/** The caller may act on this person's expenses: their own (SELF) or anyone's with `scope`. */
function mayActFor(auth: Auth, personId: string, scope: string): void {
  if (auth.scopes.has(scope)) return
  if (auth.scopes.has(SELF) && auth.person?.id === personId) return
  throw forbidden('That is not your expense.')
}

/** Who a new line or report is for: someone named (needs expenses:write), else the caller. */
async function subjectOf(req: Request, auth: Auth): Promise<Person> {
  const named = str(req.body?.personId, 80)
  if (named && named !== auth.person?.id) {
    requireScope(req, 'expenses:write')
    const p = await prisma.person.findFirst({ where: { id: named, companyId: auth.companyId, active: true } })
    if (!p) throw notFound('Person')
    return p
  }
  requireScope(req, SELF, 'expenses:write')
  return requirePerson(auth)
}

async function rateOn(companyId: string, date: string): Promise<number> {
  const rate = await prisma.mileageRate.findFirst({ where: { companyId, effectiveFrom: { lte: date } }, orderBy: { effectiveFrom: 'desc' } })
  if (!rate) throw conflict('no_mileage_rate', `There is no mileage rate in force on ${date}. An admin adds one under Manage → Expenses.`)
  return rate.rateMills
}

interface LineFields {
  date?: string
  categoryId?: string
  jobId?: string | null
  amountCents?: number
  miles?: number | null
  paidBy?: string
  vendor?: string
  notes?: string
}

function fieldsOf(b: Record<string, unknown>): LineFields {
  const f: LineFields = {}
  if (b.date !== undefined) {
    const d = str(b.date, 10)
    if (!isYmd(d)) throw badRequest('date must be a date like 2026-10-17.', { field: 'date' })
    f.date = d
  }
  if (b.categoryId !== undefined) f.categoryId = requiredStr(b.categoryId, 'categoryId', 80)
  if (b.jobId !== undefined) f.jobId = b.jobId === null || b.jobId === '' ? null : str(b.jobId, 80)
  if (b.amount !== undefined && b.amount !== null && b.amount !== '') f.amountCents = toCents(b.amount, 'amount')
  if (b.miles !== undefined) {
    if (b.miles === null || b.miles === '') f.miles = null
    else {
      const m = Number(b.miles)
      if (!Number.isFinite(m) || m <= 0 || m > 5000) throw badRequest('miles must be a number of miles above 0.', { field: 'miles' })
      f.miles = Math.round(m * 10) / 10
    }
  }
  if (b.paidBy !== undefined) {
    const p = str(b.paidBy, 20)
    if (!PAID_BY.includes(p)) throw badRequest('paidBy must be employee (to be paid back) or company (company card).', { field: 'paidBy' })
    f.paidBy = p
  }
  if (b.vendor !== undefined) f.vendor = str(b.vendor, 200)
  if (b.notes !== undefined) f.notes = str(b.notes, 1000)
  return f
}

/** Work out amount and rate from category, miles and amount. Mileage lines are always miles × rate. */
async function priced(companyId: string, f: Required<Pick<LineFields, 'date' | 'categoryId'>> & LineFields) {
  const cat = await prisma.expenseCategory.findFirst({ where: { id: f.categoryId, companyId } })
  if (!cat) throw notFound('Expense category')
  if (!cat.active) throw badRequest(`${cat.name} is no longer used. Pick another category.`, { field: 'categoryId' })
  if (cat.mileage) {
    if (!f.miles) throw badRequest('Enter the miles for a mileage line.', { field: 'miles' })
    const rateMills = await rateOn(companyId, f.date)
    return { amountCents: mileageCents(f.miles, rateMills), miles: f.miles, rateMills }
  }
  if (f.amountCents === undefined) throw badRequest('Enter the amount.', { field: 'amount' })
  if (f.amountCents <= 0) throw badRequest('The amount must be more than 0. Record a refund as a note to the approver.', { field: 'amount' })
  if (f.amountCents > 10_000_000) throw badRequest('That amount is over $100,000. Check it, or enter it in accounting directly.', { field: 'amount' })
  return { amountCents: f.amountCents, miles: null, rateMills: null }
}

async function checkJob(companyId: string, jobId: string | null | undefined) {
  if (!jobId) return
  const job = await prisma.job.findFirst({ where: { id: jobId, companyId } })
  if (!job) throw notFound('Job')
}

/** The line, locked, if the caller may change it and it is still open to change. */
async function editableLine(tx: Tx, auth: Auth, id: string) {
  await tx.$queryRaw`SELECT id FROM "Expense" WHERE id = ${id} FOR UPDATE`
  const line = await tx.expense.findFirst({ where: { id, companyId: auth.companyId }, include: { report: true } })
  if (!line) throw notFound('Expense')
  mayActFor(auth, line.personId, 'expenses:write')
  if (line.report && !EDITABLE.includes(line.report.status)) {
    throw conflict('expense_locked', `This line is in a report that is ${line.report.status}, so it can no longer be changed.`)
  }
  return line
}

// ─── Lookups ────────────────────────────────────────────────────────────────

route(
  expensesRouter,
  { method: 'get', path: '/expense-categories', tag: 'Expenses', summary: 'Expense categories, in order.', access: [SELF, 'expenses:read'], query: { active: 'true (default), false, or all' } },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:read')
    return {
      data: await prisma.expenseCategory.findMany({
        where: { companyId: auth.companyId, active: req.query.active === 'all' ? undefined : bool(req.query.active) ?? true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    }
  },
)

route(
  expensesRouter,
  {
    method: 'post',
    path: '/expense-categories',
    tag: 'Expenses',
    summary: 'Add a category.',
    access: ['expenses:write'],
    status: 201,
    body: { name: 'Name', accountCode: 'Account code accounting posts it to', mileage: 'true if lines are miles × the mileage rate', sortOrder: 'Position in the list' },
  },
  async (req) => {
    const auth = requireScope(req, 'expenses:write')
    const b = req.body ?? {}
    const category = await prisma.expenseCategory.create({
      data: {
        companyId: auth.companyId,
        name: requiredStr(b.name, 'name', 100),
        accountCode: str(b.accountCode, 40),
        mileage: bool(b.mileage) ?? false,
        sortOrder: Number.isFinite(Number(b.sortOrder)) ? Math.round(Number(b.sortOrder)) : 1000,
      },
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
    summary: 'Change a category. Set active to false to retire it; old lines keep it.',
    access: ['expenses:write'],
    body: { name: 'Name', accountCode: 'Account code', sortOrder: 'Position', active: 'true or false' },
  },
  async (req) => {
    const auth = requireScope(req, 'expenses:write')
    const existing = await prisma.expenseCategory.findFirst({ where: { id: req.params.id, companyId: auth.companyId } })
    if (!existing) throw notFound('Expense category')
    const b = req.body ?? {}
    const category = await prisma.expenseCategory.update({
      where: { id: existing.id },
      data: {
        name: b.name === undefined ? undefined : requiredStr(b.name, 'name', 100),
        accountCode: b.accountCode === undefined ? undefined : str(b.accountCode, 40),
        sortOrder: b.sortOrder === undefined ? undefined : Math.round(Number(b.sortOrder)) || 0,
        active: bool(b.active),
      },
    })
    return { category }
  },
)

route(
  expensesRouter,
  { method: 'get', path: '/mileage-rates', tag: 'Expenses', summary: 'Mileage rates by the date they took effect, newest first, and the one in force today.', access: [SELF, 'expenses:read'] },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:read')
    const rates = await prisma.mileageRate.findMany({ where: { companyId: auth.companyId }, orderBy: { effectiveFrom: 'desc' } })
    const today = new Date().toISOString().slice(0, 10)
    const current = rates.find((r) => r.effectiveFrom <= today) ?? null
    const view = (r: (typeof rates)[number]) => ({ ...r, centsPerMile: r.rateMills / 10 })
    return { data: rates.map(view), current: current ? view(current) : null }
  },
)

route(
  expensesRouter,
  {
    method: 'post',
    path: '/mileage-rates',
    tag: 'Expenses',
    summary: 'Add a mileage rate from a date. Lines already saved keep the rate they were priced at.',
    access: ['expenses:write'],
    status: 201,
    body: { effectiveFrom: 'YYYY-MM-DD', centsPerMile: 'e.g. 72.5', note: 'Where the rate comes from' },
  },
  async (req) => {
    const auth = requireScope(req, 'expenses:write')
    const b = req.body ?? {}
    const effectiveFrom = str(b.effectiveFrom, 10)
    if (!isYmd(effectiveFrom)) throw badRequest('effectiveFrom must be a date like 2026-01-01.', { field: 'effectiveFrom' })
    const rate = await prisma.mileageRate.create({
      data: { companyId: auth.companyId, effectiveFrom, rateMills: centsPerMileToMills(b.centsPerMile, 'centsPerMile'), note: str(b.note, 200) },
    })
    return { rate: { ...rate, centsPerMile: rate.rateMills / 10 } }
  },
)

// ─── Lines ──────────────────────────────────────────────────────────────────

route(
  expensesRouter,
  {
    method: 'get',
    path: '/expenses',
    tag: 'Expenses',
    summary: 'Expense and mileage lines, newest first. Without expenses:read you see only your own.',
    access: [SELF, 'expenses:read'],
    query: {
      personId: 'Only this person',
      jobId: 'Only this job',
      status: 'draft (not yet submitted, or sent back) | submitted | approved | rejected | exported',
      reportId: 'Only lines in this report',
      from: 'YYYY-MM-DD, inclusive',
      to: 'YYYY-MM-DD, inclusive',
      limit: 'Page size, 100 by default, 500 at most',
      cursor: 'nextCursor from the previous page',
    },
  },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:read')
    const all = auth.scopes.has('expenses:read')
    const personId = all ? str(req.query.personId, 80) || undefined : requirePerson(auth).id
    const status = str(req.query.status, 20)
    const from = str(req.query.from, 10)
    const to = str(req.query.to, 10)
    const where: Prisma.ExpenseWhereInput = {
      companyId: auth.companyId,
      personId,
      jobId: str(req.query.jobId, 80) || undefined,
      reportId: str(req.query.reportId, 80) || undefined,
      date: from || to ? { gte: from || undefined, lte: to || undefined } : undefined,
      ...(status === 'draft' ? { OR: [{ reportId: null }, { report: { status: { in: EDITABLE } } }] } : status ? { report: { status } } : {}),
    }
    const limit = limitOf(req.query.limit)
    const cursor = str(req.query.cursor, 80)
    const rows = await prisma.expense.findMany({
      where,
      include: lineInclude,
      orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    })
    const page = rows.slice(0, limit)
    return { data: page.map(lineView), nextCursor: rows.length > limit ? page[page.length - 1].id : null }
  },
)

route(
  expensesRouter,
  {
    method: 'post',
    path: '/expenses',
    tag: 'Expenses',
    summary: 'Add an expense or mileage line. For a mileage category send miles; the amount is worked out from the rate on that date.',
    access: [SELF, 'expenses:write'],
    status: 201,
    body: {
      date: 'YYYY-MM-DD (required)',
      categoryId: 'Category (required)',
      jobId: 'Job it is charged to',
      amount: 'Amount like 12.34 (not for mileage)',
      miles: 'Miles (mileage categories only)',
      paidBy: 'employee (pay back) or company (company card). Default employee',
      vendor: 'Where it was bought',
      notes: 'Note for the approver',
      personId: 'Enter it for someone else (needs expenses:write)',
      clientId: 'Id generated by the sender. Re-sending the same clientId does nothing',
    },
  },
  async (req) => {
    const auth = requireAuth(req)
    const person = await subjectOf(req, auth)
    const b = (req.body ?? {}) as Record<string, unknown>
    const f = fieldsOf(b)
    if (!f.date) throw badRequest('date is required.', { field: 'date' })
    if (!f.categoryId) throw badRequest('categoryId is required.', { field: 'categoryId' })
    const clientId = str(b.clientId, 80) || null
    if (clientId) {
      const seen = await prisma.expense.findUnique({ where: { companyId_clientId: { companyId: auth.companyId, clientId } }, include: lineInclude })
      if (seen) return { duplicate: true, expense: lineView(seen) }
    }
    await checkJob(auth.companyId, f.jobId)
    const price = await priced(auth.companyId, { ...f, date: f.date, categoryId: f.categoryId })
    const line = await prisma.expense.create({
      data: {
        companyId: auth.companyId,
        personId: person.id,
        date: f.date,
        categoryId: f.categoryId,
        jobId: f.jobId ?? null,
        ...price,
        paidBy: f.paidBy ?? 'employee',
        vendor: f.vendor ?? '',
        notes: f.notes ?? '',
        clientId,
      },
      include: lineInclude,
    })
    return { expense: lineView(line) }
  },
)

route(
  expensesRouter,
  {
    method: 'patch',
    path: '/expenses/:id',
    tag: 'Expenses',
    summary: 'Change a line while it is a draft or sent back.',
    access: [SELF, 'expenses:write'],
    body: { date: 'YYYY-MM-DD', categoryId: 'Category', jobId: 'Job, or null', amount: 'Amount', miles: 'Miles', paidBy: 'employee | company', vendor: 'Vendor', notes: 'Note' },
  },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:write')
    const f = fieldsOf((req.body ?? {}) as Record<string, unknown>)
    await checkJob(auth.companyId, f.jobId)
    const line = await prisma.$transaction(async (tx) => {
      const before = await editableLine(tx, auth, req.params.id)
      const merged = {
        date: f.date ?? before.date,
        categoryId: f.categoryId ?? before.categoryId,
        amountCents: f.amountCents ?? before.amountCents,
        miles: f.miles === undefined ? before.miles : f.miles,
      }
      const price = await priced(auth.companyId, merged)
      return tx.expense.update({
        where: { id: before.id },
        data: { date: merged.date, categoryId: merged.categoryId, jobId: f.jobId, paidBy: f.paidBy, vendor: f.vendor, notes: f.notes, ...price },
        include: lineInclude,
      })
    })
    return { expense: lineView(line) }
  },
)

route(
  expensesRouter,
  { method: 'delete', path: '/expenses/:id', tag: 'Expenses', summary: 'Remove a line while it is a draft or sent back. Its receipt goes with it.', access: [SELF, 'expenses:write'] },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:write')
    await prisma.$transaction(async (tx) => {
      const line = await editableLine(tx, auth, req.params.id)
      await tx.expense.delete({ where: { id: line.id } })
    })
    return { deleted: true }
  },
)

// Receipts arrive as the raw file body, not JSON.
expensesRouter.use('/expenses/:id/receipt', express.raw({ type: RECEIPT_TYPES, limit: RECEIPT_MAX }))

route(
  expensesRouter,
  {
    method: 'post',
    path: '/expenses/:id/receipt',
    tag: 'Expenses',
    summary: 'Attach the receipt: send the photo or PDF itself as the body, with its Content-Type (jpeg, png, webp, heic, pdf; 10 MB at most). Replaces any earlier receipt.',
    access: [SELF, 'expenses:write'],
  },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:write')
    const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
    if (!RECEIPT_TYPES.includes(type)) throw new ApiError(415, 'unsupported_type', `Send the receipt as one of: ${RECEIPT_TYPES.join(', ')}.`)
    const data = req.body
    if (!Buffer.isBuffer(data) || !data.length) throw badRequest('The receipt file is empty.')
    const bytes = new Uint8Array(data)
    const receipt = await prisma.$transaction(async (tx) => {
      const line = await editableLine(tx, auth, req.params.id)
      return tx.receipt.upsert({
        where: { expenseId: line.id },
        create: { companyId: auth.companyId, expenseId: line.id, mimeType: type, bytes: bytes.length, data: bytes },
        update: { mimeType: type, bytes: bytes.length, data: bytes, createdAt: new Date() },
        select: { id: true, mimeType: true, bytes: true, createdAt: true },
      })
    })
    return { receipt }
  },
)

route(
  expensesRouter,
  { method: 'get', path: '/expenses/:id/receipt', tag: 'Expenses', summary: 'The receipt file itself.', access: [SELF, 'expenses:read'] },
  async (req, res) => {
    const auth = requireScope(req, SELF, 'expenses:read')
    const line = await prisma.expense.findFirst({ where: { id: req.params.id, companyId: auth.companyId }, include: { receipt: true } })
    if (!line) throw notFound('Expense')
    mayActFor(auth, line.personId, 'expenses:read')
    if (!line.receipt) throw notFound('Receipt')
    res.setHeader('Content-Type', line.receipt.mimeType)
    res.setHeader('Content-Length', String(line.receipt.bytes))
    res.setHeader('Cache-Control', 'private, max-age=300')
    res.setHeader('Content-Disposition', `inline; filename="receipt-${line.date}${line.receipt.mimeType === 'application/pdf' ? '.pdf' : ''}"`)
    res.status(200).end(Buffer.from(line.receipt.data))
    return undefined
  },
)

route(
  expensesRouter,
  { method: 'delete', path: '/expenses/:id/receipt', tag: 'Expenses', summary: 'Remove the receipt while the line can still be changed.', access: [SELF, 'expenses:write'] },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:write')
    await prisma.$transaction(async (tx) => {
      const line = await editableLine(tx, auth, req.params.id)
      await tx.receipt.deleteMany({ where: { expenseId: line.id } })
    })
    return { deleted: true }
  },
)

// ─── Reports and approval ───────────────────────────────────────────────────

const reportInclude = {
  expenses: { include: lineInclude, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.ExpenseReportInclude

type ReportRow = Prisma.ExpenseReportGetPayload<{ include: typeof reportInclude }>

async function reportView(r: ReportRow) {
  const person = await prisma.person.findUnique({ where: { id: r.personId }, select: { id: true, name: true, email: true } })
  const decidedBy = r.decidedById ? await prisma.person.findUnique({ where: { id: r.decidedById }, select: { id: true, name: true } }) : null
  const lines = r.expenses.map(lineView)
  const sum = (xs: typeof lines) => xs.reduce((t, l) => t + l.amountCents, 0)
  return {
    id: r.id,
    personId: r.personId,
    person,
    title: r.title,
    status: r.status,
    submittedAt: r.submittedAt,
    decidedBy,
    decidedAt: r.decidedAt,
    decisionNote: r.decisionNote,
    exportedAt: r.exportedAt,
    totalCents: sum(lines),
    reimbursableCents: sum(lines.filter((l) => l.paidBy === 'employee')),
    companyCardCents: sum(lines.filter((l) => l.paidBy === 'company')),
    missingReceipts: lines.filter((l) => !l.receipt && !l.category.mileage).length,
    lines,
    createdAt: r.createdAt,
  }
}

const summaryOf = (r: { id: string; personId: string; status: string }, totalCents: number) => ({ id: r.id, personId: r.personId, status: r.status, totalCents })

async function lockedReport(tx: Tx, companyId: string, id: string) {
  await tx.$queryRaw`SELECT id FROM "ExpenseReport" WHERE id = ${id} FOR UPDATE`
  const r = await tx.expenseReport.findFirst({ where: { id, companyId }, include: { expenses: { select: { amountCents: true } } } })
  if (!r) throw notFound('Expense report')
  return r
}

route(
  expensesRouter,
  {
    method: 'post',
    path: '/expense-reports',
    tag: 'Expenses',
    summary: "Gather lines into a report. Without expenseIds it takes all of the person's lines that are not in a report yet. With submit: true it goes straight to approval.",
    access: [SELF, 'expenses:write'],
    status: 201,
    body: { title: 'e.g. "Week of Oct 12"', expenseIds: 'Lines to include', submit: 'true to submit at once', personId: 'For someone else (needs expenses:write)' },
  },
  async (req) => {
    const auth = requireAuth(req)
    const person = await subjectOf(req, auth)
    const b = req.body ?? {}
    const ids: string[] | null = Array.isArray(b.expenseIds) ? b.expenseIds.map((x: unknown) => str(x, 80)).filter(Boolean) : null
    const submit = bool(b.submit) ?? false
    const created = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Person" WHERE id = ${person.id} FOR UPDATE`
      const lines = await tx.expense.findMany({
        where: { companyId: auth.companyId, personId: person.id, reportId: null, ...(ids ? { id: { in: ids } } : {}) },
        select: { id: true, amountCents: true },
      })
      if (ids && lines.length !== new Set(ids).size) throw conflict('expense_unavailable', 'Some of those lines are not yours, or are already in a report.')
      if (!lines.length) throw conflict('nothing_to_submit', 'There are no lines waiting to go in a report.')
      const report = await tx.expenseReport.create({
        data: {
          companyId: auth.companyId,
          personId: person.id,
          title: str(b.title, 120),
          status: submit ? 'submitted' : 'draft',
          submittedAt: submit ? new Date() : null,
        },
      })
      await tx.expense.updateMany({ where: { id: { in: lines.map((l) => l.id) } }, data: { reportId: report.id } })
      if (submit) await emit(tx, auth.companyId, 'expense.submitted', { report: summaryOf(report, lines.reduce((t, l) => t + l.amountCents, 0)) })
      return report.id
    })
    return { report: await reportView(await prisma.expenseReport.findUniqueOrThrow({ where: { id: created }, include: reportInclude })) }
  },
)

route(
  expensesRouter,
  {
    method: 'get',
    path: '/expense-reports',
    tag: 'Expenses',
    summary: 'Reports with their lines, newest first. Without expenses:read you see only your own.',
    access: [SELF, 'expenses:read'],
    query: { status: 'draft | submitted | approved | rejected | exported', personId: 'Only this person', limit: 'Page size, 50 by default' },
  },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:read')
    const all = auth.scopes.has('expenses:read')
    const rows = await prisma.expenseReport.findMany({
      where: {
        companyId: auth.companyId,
        personId: all ? str(req.query.personId, 80) || undefined : requirePerson(auth).id,
        status: str(req.query.status, 20) || undefined,
      },
      include: reportInclude,
      orderBy: [{ submittedAt: 'desc' }, { createdAt: 'desc' }],
      take: limitOf(req.query.limit, 50, 200),
    })
    return { data: await Promise.all(rows.map(reportView)) }
  },
)

route(
  expensesRouter,
  { method: 'get', path: '/expense-reports/:id', tag: 'Expenses', summary: 'One report with its lines.', access: [SELF, 'expenses:read'] },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:read')
    const r = await prisma.expenseReport.findFirst({ where: { id: req.params.id, companyId: auth.companyId }, include: reportInclude })
    if (!r) throw notFound('Expense report')
    mayActFor(auth, r.personId, 'expenses:read')
    return { report: await reportView(r) }
  },
)

route(
  expensesRouter,
  { method: 'post', path: '/expense-reports/:id/submit', tag: 'Expenses', summary: 'Send a draft or sent-back report for approval.', access: [SELF, 'expenses:write'] },
  async (req) => {
    const auth = requireScope(req, SELF, 'expenses:write')
    await prisma.$transaction(async (tx) => {
      const r = await lockedReport(tx, auth.companyId, req.params.id)
      mayActFor(auth, r.personId, 'expenses:write')
      if (!EDITABLE.includes(r.status)) throw conflict('not_submittable', `This report is already ${r.status}.`)
      if (!r.expenses.length) throw conflict('nothing_to_submit', 'This report has no lines.')
      const saved = await tx.expenseReport.update({ where: { id: r.id }, data: { status: 'submitted', submittedAt: new Date(), decisionNote: '' } })
      await emit(tx, auth.companyId, 'expense.submitted', { report: summaryOf(saved, r.expenses.reduce((t, l) => t + l.amountCents, 0)) })
    })
    return { report: await reportView(await prisma.expenseReport.findUniqueOrThrow({ where: { id: req.params.id }, include: reportInclude })) }
  },
)

for (const action of ['approve', 'reject'] as const) {
  route(
    expensesRouter,
    {
      method: 'post',
      path: `/expense-reports/:id/${action}`,
      tag: 'Expenses',
      summary: action === 'approve' ? 'Approve a submitted report. Its lines lock.' : 'Send a submitted report back to the person with a note. They can fix it and submit again.',
      access: ['expenses:approve'],
      body: { note: action === 'approve' ? 'Optional note' : 'What needs fixing (required)' },
    },
    async (req) => {
      const auth = requireScope(req, 'expenses:approve')
      const note = str(req.body?.note, 500)
      if (action === 'reject' && !note) throw badRequest('Say what needs fixing.', { field: 'note' })
      await prisma.$transaction(async (tx) => {
        const r = await lockedReport(tx, auth.companyId, req.params.id)
        if (r.status !== 'submitted') throw conflict('not_pending', `This report is ${r.status}, not waiting for approval.`)
        if (r.personId === auth.person?.id && !isAdmin(auth)) throw forbidden('Someone else has to approve your own expenses.')
        const saved = await tx.expenseReport.update({
          where: { id: r.id },
          data: { status: action === 'approve' ? 'approved' : 'rejected', decidedById: auth.via === 'session' ? auth.person?.id ?? null : null, decidedAt: new Date(), decisionNote: note },
        })
        await emit(tx, auth.companyId, action === 'approve' ? 'expense.approved' : 'expense.rejected', {
          report: summaryOf(saved, r.expenses.reduce((t, l) => t + l.amountCents, 0)),
        })
      })
      return { report: await reportView(await prisma.expenseReport.findUniqueOrThrow({ where: { id: req.params.id }, include: reportInclude })) }
    },
  )
}

route(
  expensesRouter,
  {
    method: 'post',
    path: '/expense-reports/:id/mark-exported',
    tag: 'Expenses',
    summary: 'Record that an approved report has gone to payroll or accounts payable.',
    access: ['expenses:approve'],
  },
  async (req) => {
    const auth = requireScope(req, 'expenses:approve')
    await prisma.$transaction(async (tx) => {
      const r = await lockedReport(tx, auth.companyId, req.params.id)
      if (r.status !== 'approved') throw conflict('not_approved', `Only an approved report can be exported; this one is ${r.status}.`)
      const saved = await tx.expenseReport.update({ where: { id: r.id }, data: { status: 'exported', exportedAt: new Date() } })
      await emit(tx, auth.companyId, 'expense.exported', { report: summaryOf(saved, r.expenses.reduce((t, l) => t + l.amountCents, 0)) })
    })
    return { report: await reportView(await prisma.expenseReport.findUniqueOrThrow({ where: { id: req.params.id }, include: reportInclude })) }
  },
)

// ─── Totals ─────────────────────────────────────────────────────────────────

const EXPENSE_GROUPS = ['person', 'job', 'category', 'paidBy', 'month'] as const

route(
  expensesRouter,
  {
    method: 'get',
    path: '/reports/expenses',
    tag: 'Views',
    summary: 'Expense totals in cents, grouped by any of person, job, category, paidBy, month.',
    access: ['expenses:read', 'reports:read'],
    query: {
      from: 'YYYY-MM-DD, inclusive',
      to: 'YYYY-MM-DD, inclusive',
      groupBy: `Comma-separated: ${EXPENSE_GROUPS.join(', ')}. Defaults to job`,
      status: 'Comma-separated report statuses to count. Defaults to approved,exported',
      jobId: 'Only this job',
    },
  },
  async (req) => {
    const auth = requireScope(req, 'expenses:read', 'reports:read')
    const groups = (str(req.query.groupBy, 100) || 'job').split(',').map((g) => g.trim()).filter(Boolean)
    for (const g of groups) if (!(EXPENSE_GROUPS as readonly string[]).includes(g)) throw badRequest(`groupBy accepts ${EXPENSE_GROUPS.join(', ')}.`, { field: 'groupBy' })
    const statuses = (str(req.query.status, 100) || 'approved,exported').split(',').map((s) => s.trim()).filter(Boolean)
    const from = str(req.query.from, 10)
    const to = str(req.query.to, 10)
    const lines = await prisma.expense.findMany({
      where: {
        companyId: auth.companyId,
        jobId: str(req.query.jobId, 80) || undefined,
        date: from || to ? { gte: from || undefined, lte: to || undefined } : undefined,
        ...(statuses.includes('draft') ? { OR: [{ reportId: null }, { report: { status: { in: statuses } } }] } : { report: { status: { in: statuses } } }),
      },
      include: lineInclude,
      take: 50_001,
    })
    if (lines.length > 50_000) throw badRequest('That range holds too many lines. Narrow the dates.')
    const rows = new Map<string, Record<string, unknown> & { totalCents: number; lines: number; miles: number }>()
    let total = 0
    for (const l of lines) {
      const key = groups
        .map((g) => (g === 'person' ? l.personId : g === 'job' ? l.jobId ?? '-' : g === 'category' ? l.categoryId : g === 'paidBy' ? l.paidBy : l.date.slice(0, 7)))
        .join('|')
      let row = rows.get(key)
      if (!row) {
        row = { totalCents: 0, lines: 0, miles: 0 }
        if (groups.includes('person')) Object.assign(row, { personId: l.personId, personName: l.person.name })
        if (groups.includes('job')) Object.assign(row, { jobId: l.jobId, jobName: l.job?.name ?? '(no job)', jobCode: l.job?.code ?? '' })
        if (groups.includes('category')) Object.assign(row, { categoryId: l.categoryId, categoryName: l.category.name, accountCode: l.category.accountCode })
        if (groups.includes('paidBy')) row.paidBy = l.paidBy
        if (groups.includes('month')) row.month = l.date.slice(0, 7)
        rows.set(key, row)
      }
      row.totalCents += l.amountCents
      row.lines += 1
      row.miles = Math.round((row.miles + (l.miles ?? 0)) * 10) / 10
      total += l.amountCents
    }
    return { from: from || null, to: to || null, groupBy: groups, statuses, totalCents: total, rows: [...rows.values()] }
  },
)
