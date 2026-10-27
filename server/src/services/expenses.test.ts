import { test } from 'node:test'
import assert from 'node:assert/strict'
import { postingAccount } from './expenses.js'

const fuel = { kind: 'expense', accountCode: '6-1150' }
const mileage = { kind: 'mileage', accountCode: '6-1100' }

test('own-money lines post to the reimbursement account', () => {
  assert.equal(postingAccount({ paidBy: 'employee', category: fuel }, '6-1140'), '6-1140')
})

test('company-card lines post to their category', () => {
  assert.equal(postingAccount({ paidBy: 'company_card', category: fuel }, '6-1140'), '6-1150')
})

test('mileage keeps its own account', () => {
  assert.equal(postingAccount({ paidBy: 'employee', category: mileage }, '6-1140'), '6-1100')
})

test('with no reimbursement account, every line posts to its category', () => {
  assert.equal(postingAccount({ paidBy: 'employee', category: fuel }, ''), '6-1150')
  assert.equal(postingAccount({ paidBy: 'employee', category: fuel }, null), '6-1150')
})
