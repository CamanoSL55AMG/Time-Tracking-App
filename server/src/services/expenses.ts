import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { Expense, Person, Prisma } from '@prisma/client'
import { prisma } from '../db.js'
import { badRequest, conflict, forbidden, notFound } from '../errors.js'
import { isYmd, localDate } from '../lib/time.js'
import { emit } from './events.js'

// Expenses and mileage. A person adds a line on their phone: charged to the job they
// are clocked into (their current flight), to a job they pick, or to no job. Lines
// are submitted when added; a manager or payroll approves or rejects them. The
// owner can change or remove a line until it is approved; changing a rejected line
// sends it back in. Receipts are stored on disk beside the app, never in the repo.

const here = path.dirname(fileURLToPath(import.meta.url))
export const RECEIPT_DIR = path.resolve(here, '..', '..', 'uploads', 'receipts')
const RECEIPT_TYPES: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'application/pdf': '.pdf' }
const MAX_RECEIPT_BYTES = 6 * 1024 * 1024
const MAX_CENTS = 10_000_00 // $10,000 on one line

export const PAID_BY = ['employee', 'company_card'] as const

export const expenseInclude = {
  job: { select: { id: true, name: true, code: true, kind: true } },
  category: { select: { id: true, name: true, kind: true, accountCode: true } },
  person: { select: { id: true, name: true, email: true } },
  company: { select: { reimbursementAccountCode: true } },
} satisfies Prisma.ExpenseInclude
export type ExpenseRow = Prisma.ExpenseGetPayload<{ include: typeof expenseInclude }>

/**
 * The account a line posts to in accounting. Own-money lines go to the company's
 * reimbursement account when one is set (Morgan Sound: 6-1140 Employee Business
 * Expense); mileage and company-card lines go to their category's account.
 */
export function postingAccount(e: { paidBy: string; category: { kind: string; accountCode: string } }, reimbursementAccountCode: string | null | undefined): string {
  if (e.paidBy === 'employee' && e.category.kind !== 'mileage' && reimbursementAccountCode) return reimbursementAccountCode
  return e.category.accountCode
}

/** What leaves the API: the receipt path stays on the server. */
export const shape = (e: ExpenseRow) => {
  const { receiptPath, company, ...rest } = e
  return {
    ...rest,
    amount: e.amountCents / 100,
    hasReceipt: Boolean(receiptPath),
    postingAccount: postingAccount(e, company.reimbursementAccountCode),
  }
}

export interface ExpenseInput {
  jobId?: string | null
  /** Charge it to the job the person is clocked into right now. */
  currentFlight?: boolean
  date?: string
  categoryId?: string
  amount?: number
  miles?: number
  paidBy?: string
  vendor?: string
  notes?: string
  draft?: boolean
  clientId?: string
}

async function priced(companyId: string, input: ExpenseInput, existing?: Expense) {
  const categoryId = input.categoryId ?? existing?.categoryId
  if (!categoryId) throw badRequest('Pick a category.', { field: 'categoryId' })
  const category = await prisma.expenseCategory.findFirst({ where: { id: categoryId, companyId } })
  if (!category) throw notFound('Category')
  if (!category.active && category.id !== existing?.categoryId) throw conflict('category_inactive', `${category.name} is no longer used.`)

  if (category.kind === 'mileage') {
    const miles = input.miles ?? existing?.miles ?? undefined
    if (miles === undefined || !Number.isFinite(miles) || miles <= 0 || miles > 5000) throw badRequest('Enter the miles driven (more than 0).', { field: 'miles' })
    const company = await prisma.company.findUniqueOrThrow({ where: { id: companyId } })
    // Keep the rate the line was entered at unless the miles change.
    const rate = existing?.ratePerMile && input.miles === undefined && existing.categoryId === category.id ? existing.ratePerMile : company.mileageRate
    return { category, amountCents: Math.round(miles * rate * 100), miles, ratePerMile: rate }
  }
  const amount = input.amount ?? (existing ? existing.amountCents / 100 : undefined)
  if (amount === undefined || !Number.isFinite(amount) || amount <= 0) throw badRequest('Enter the amount (more than 0).', { field: 'amount' })
  const amountCents = Math.round(amount * 100)
  if (amountCents > MAX_CENTS) throw badRequest('One line cannot be more than $10,000. Split it, or ask the office.', { field: 'amount' })
  return { category, amountCents, miles: null, ratePerMile: null }
}

async function jobFor(person: Person, input: ExpenseInput): Promise<{ jobId: string | null; punchId: string | null } | undefined> {
  if (input.currentFlight) {
    const open = await prisma.punch.findFirst({ where: { personId: person.id, clockOut: null } })
    if (!open) throw conflict('not_clocked_in', 'You are not on a flight right now. Clock in, or pick the job.')
    return { jobId: open.jobId, punchId: open.id }
  }
  if (input.jobId === undefined) return undefined
  if (input.jobId === null || input.jobId === '') return { jobId: null, punchId: null }
  const job = await prisma.job.findFirst({ where: { id: input.jobId, companyId: person.companyId } })
  if (!job) throw notFound('Job')
  return { jobId: job.id, punchId: null }
}

function checkPaidBy(v: string | undefined) {
  if (v !== undefined && !(PAID_BY as readonly string[]).includes(v)) throw badRequest('paidBy must be employee or company_card.', { field: 'paidBy' })
}

export async function addExpense(person: Person, input: ExpenseInput) {
  if (input.clientId) {
    const dup = await prisma.expense.findUnique({ where: { companyId_clientId: { companyId: person.companyId, clientId: input.clientId } }, include: expenseInclude })
    if (dup) return dup
  }
  checkPaidBy(input.paidBy)
  const company = await prisma.company.findUniqueOrThrow({ where: { id: person.companyId } })
  const today = localDate(new Date(), company.timezone)
  const date = input.date || today
  if (!isYmd(date)) throw badRequest('date must be YYYY-MM-DD.', { field: 'date' })
  if (date > today) throw badRequest('An expense cannot be dated in the future.', { field: 'date' })
  const price = await priced(person.companyId, input)
  const where = (await jobFor(person, input)) ?? { jobId: null, punchId: null }
  const draft = input.draft === true

  return prisma.$transaction(async (tx) => {
    const e = await tx.expense.create({
      data: {
        companyId: person.companyId,
        personId: person.id,
        jobId: where.jobId,
        punchId: where.punchId,
        date,
        categoryId: price.category.id,
        amountCents: price.amountCents,
        miles: price.miles,
        ratePerMile: price.ratePerMile,
        paidBy: input.paidBy ?? 'employee',
        vendor: input.vendor ?? '',
        notes: input.notes ?? '',
        status: draft ? 'draft' : 'submitted',
        submittedAt: draft ? null : new Date(),
        clientId: input.clientId || null,
      },
      include: expenseInclude,
    })
    if (!draft) await emit(tx, person.companyId, 'expense.submitted', { expense: eventShape(e) })
    return e
  })
}

const eventShape = (e: ExpenseRow) => ({
  id: e.id,
  personId: e.personId,
  jobId: e.jobId,
  jobCode: e.job?.code ?? null,
  date: e.date,
  category: e.category.name,
  amount: e.amountCents / 100,
  paidBy: e.paidBy,
  status: e.status,
})

async function own(person: Person, id: string): Promise<Expense> {
  const e = await prisma.expense.findFirst({ where: { id, companyId: person.companyId } })
  if (!e) throw notFound('Expense')
  if (e.personId !== person.id) throw forbidden('That is not your expense.')
  return e
}

export async function changeExpense(person: Person, id: string, input: ExpenseInput) {
  const e = await own(person, id)
  if (e.status === 'approved') throw conflict('expense_approved', 'This expense is approved and can no longer change. Ask the office.')
  checkPaidBy(input.paidBy)
  if (input.date !== undefined) {
    const company = await prisma.company.findUniqueOrThrow({ where: { id: person.companyId } })
    if (!isYmd(input.date)) throw badRequest('date must be YYYY-MM-DD.', { field: 'date' })
    if (input.date > localDate(new Date(), company.timezone)) throw badRequest('An expense cannot be dated in the future.', { field: 'date' })
  }
  const price = await priced(person.companyId, input, e)
  const where = await jobFor(person, input)
  // A fixed rejected line, or a draft sent in, goes back for approval.
  const resubmit = e.status === 'rejected' || (e.status === 'draft' && input.draft === false)
  return prisma.$transaction(async (tx) => {
    const saved = await tx.expense.update({
      where: { id: e.id },
      data: {
        ...(where ?? {}),
        date: input.date,
        categoryId: price.category.id,
        amountCents: price.amountCents,
        miles: price.miles,
        ratePerMile: price.ratePerMile,
        paidBy: input.paidBy,
        vendor: input.vendor,
        notes: input.notes,
        ...(resubmit ? { status: 'submitted', submittedAt: new Date(), decidedAt: null, decidedById: null, decisionNote: '' } : {}),
      },
      include: expenseInclude,
    })
    if (resubmit) await emit(tx, person.companyId, 'expense.submitted', { expense: eventShape(saved), resubmitted: e.status === 'rejected' })
    return saved
  })
}

export async function deleteExpense(person: Person, id: string) {
  const e = await own(person, id)
  if (e.status === 'approved') throw conflict('expense_approved', 'This expense is approved and can no longer be removed. Ask the office.')
  await prisma.$transaction(async (tx) => {
    await tx.expense.delete({ where: { id: e.id } })
    await emit(tx, person.companyId, 'expense.deleted', { id: e.id, personId: e.personId })
  })
  if (e.receiptPath) await fs.rm(path.join(RECEIPT_DIR, path.basename(e.receiptPath)), { force: true }).catch(() => undefined)
}

/** Store the receipt photo or PDF, replacing any earlier one. */
export async function attachReceipt(person: Person, id: string, contentType: string, base64: string) {
  const e = await own(person, id)
  if (e.status === 'approved') throw conflict('expense_approved', 'This expense is approved and can no longer change.')
  const ext = RECEIPT_TYPES[contentType]
  if (!ext) throw badRequest('A receipt must be a photo (JPEG, PNG, WebP) or a PDF.', { field: 'contentType' })
  const bytes = Buffer.from(base64.replace(/^data:[^,]*,/, ''), 'base64')
  if (!bytes.length) throw badRequest('The receipt is empty.', { field: 'data' })
  if (bytes.length > MAX_RECEIPT_BYTES) throw badRequest('The receipt is larger than 6 MB.', { field: 'data' })
  await fs.mkdir(RECEIPT_DIR, { recursive: true })
  const name = `${e.id}-${randomUUID().slice(0, 8)}${ext}`
  await fs.writeFile(path.join(RECEIPT_DIR, name), bytes)
  const saved = await prisma.expense.update({ where: { id: e.id }, data: { receiptPath: name, receiptType: contentType }, include: expenseInclude })
  if (e.receiptPath) await fs.rm(path.join(RECEIPT_DIR, path.basename(e.receiptPath)), { force: true }).catch(() => undefined)
  return saved
}

export async function receiptFile(companyId: string, id: string, viewer: { personId: string | null; canReadAll: boolean }) {
  const e = await prisma.expense.findFirst({ where: { id, companyId } })
  if (!e) throw notFound('Expense')
  if (!viewer.canReadAll && e.personId !== viewer.personId) throw forbidden('That is not your expense.')
  if (!e.receiptPath) throw notFound('Receipt')
  return { file: path.join(RECEIPT_DIR, path.basename(e.receiptPath)), type: e.receiptType ?? 'application/octet-stream' }
}

export async function decideExpense(approver: { companyId: string; personId: string | null }, id: string, decision: 'approve' | 'reject', note: string) {
  return prisma.$transaction(async (tx) => {
    const e = await tx.expense.findFirst({ where: { id, companyId: approver.companyId } })
    if (!e) throw notFound('Expense')
    if (approver.personId && e.personId === approver.personId) throw forbidden('Nobody approves their own expenses.')
    if (e.status !== 'submitted') throw conflict('expense_not_waiting', `This expense is ${e.status}, not waiting for a decision.`)
    if (decision === 'reject' && !note.trim()) throw badRequest('Say why it is rejected, so it can be fixed.', { field: 'note' })
    const saved = await tx.expense.update({
      where: { id: e.id },
      data: { status: decision === 'approve' ? 'approved' : 'rejected', decidedById: approver.personId, decidedAt: new Date(), decisionNote: note.trim() },
      include: expenseInclude,
    })
    await emit(tx, approver.companyId, decision === 'approve' ? 'expense.approved' : 'expense.rejected', { expense: eventShape(saved), note: note.trim() })
    return saved
  })
}

export function totals(rows: ExpenseRow[]) {
  const sum = (f: (e: ExpenseRow) => boolean) => rows.filter(f).reduce((s, e) => s + e.amountCents, 0) / 100
  return {
    count: rows.length,
    amount: sum(() => true),
    reimbursable: sum((e) => e.paidBy === 'employee' && e.status !== 'rejected'),
    waiting: sum((e) => e.status === 'submitted'),
    approved: sum((e) => e.status === 'approved'),
  }
}
