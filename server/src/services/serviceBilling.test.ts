import { test } from 'node:test'
import assert from 'node:assert/strict'
import { billableOnSite } from './serviceBilling.js'

test('the first hour on site is covered by the trip charge', () => {
  assert.equal(billableOnSite(0.75, 1, 15), 0)
  assert.equal(billableOnSite(1, 1, 15), 0)
})

test('time past the included hour rounds up to the billing step', () => {
  assert.equal(billableOnSite(1.5, 1, 15), 0.5)
  assert.equal(billableOnSite(1.51, 1, 15), 0.75)
  assert.equal(billableOnSite(1.1, 1, 30), 0.5)
})

test('a return visit with nothing included bills from the first minute', () => {
  assert.equal(billableOnSite(0.5, 0, 15), 0.5)
})

test('seconds over a step boundary are not another step', () => {
  assert.equal(billableOnSite(1.5 + 1 / 3600 / 1000, 1, 15), 0.5)
})
