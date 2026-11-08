import { test } from 'node:test'
import assert from 'node:assert/strict'
import { addMonths, dueMonths, isYm, lineDate, ordinal } from './recurringExpenses.js'

const none = new Set<string>()
const t = (startMonth: string, dayOfMonth: number, endMonth: string | null = null) => ({ startMonth, dayOfMonth, endMonth })

test('months add across the year', () => {
  assert.equal(addMonths('2026-11', 1), '2026-12')
  assert.equal(addMonths('2026-12', 1), '2027-01')
  assert.equal(addMonths('2027-01', -1), '2026-12')
  assert.equal(addMonths('2026-11', -11), '2025-12')
})

test('a short month uses its last day', () => {
  assert.equal(lineDate('2027-02', 31), '2027-02-28')
  assert.equal(lineDate('2028-02', 30), '2028-02-29')
  assert.equal(lineDate('2026-11', 31), '2026-11-30')
  assert.equal(lineDate('2026-11', 1), '2026-11-01')
})

test('this month is due once its day has come', () => {
  assert.deepEqual(dueMonths(t('2026-11', 1), '2026-11-07', none), [{ month: '2026-11', date: '2026-11-01' }])
  assert.deepEqual(dueMonths(t('2026-11', 7), '2026-11-07', none), [{ month: '2026-11', date: '2026-11-07' }])
  assert.deepEqual(dueMonths(t('2026-11', 15), '2026-11-07', none), [])
})

test('a month already made is never due again', () => {
  assert.deepEqual(dueMonths(t('2026-11', 1), '2026-11-30', new Set(['2026-11'])), [])
  assert.deepEqual(dueMonths(t('2026-11', 1), '2026-12-02', new Set(['2026-11'])), [{ month: '2026-12', date: '2026-12-01' }])
})

test('missed months are caught up after the server was off, oldest first', () => {
  assert.deepEqual(
    dueMonths(t('2026-11', 5), '2027-01-10', none).map((d) => d.month),
    ['2026-11', '2026-12', '2027-01'],
  )
})

test('nothing before the start month or after the end month', () => {
  assert.deepEqual(dueMonths(t('2027-01', 1), '2026-12-20', none), [])
  assert.deepEqual(dueMonths(t('2026-11', 1, '2026-12'), '2027-03-15', none).map((d) => d.month), ['2026-11', '2026-12'])
})

test('catch-up stops at the last twelve months', () => {
  const due = dueMonths(t('2024-01', 1), '2026-11-07', none)
  assert.equal(due.length, 12)
  assert.equal(due[0].month, '2025-12')
  assert.equal(due[11].month, '2026-11')
})

test('month and day labels', () => {
  assert.ok(isYm('2026-11'))
  assert.ok(!isYm('2026-13'))
  assert.ok(!isYm('2026-1'))
  assert.equal(ordinal(1), '1st')
  assert.equal(ordinal(2), '2nd')
  assert.equal(ordinal(3), '3rd')
  assert.equal(ordinal(11), '11th')
  assert.equal(ordinal(22), '22nd')
  assert.equal(ordinal(31), '31st')
})
