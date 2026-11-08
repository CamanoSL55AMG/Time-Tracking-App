import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accruesLeave, isWorkerType, workerTypeChange, workerTypeOn } from './workerType.js'

const person = (workerType: string, workerTypeFrom: string | null = null, priorWorkerType: string | null = null) => ({ workerType, workerTypeFrom, priorWorkerType })

test('everyone is an employee until marked otherwise', () => {
  assert.equal(workerTypeOn(person('employee'), '2026-11-02'), 'employee')
  assert.equal(workerTypeOn(person('anything-else'), '2026-11-02'), 'employee')
  assert.ok(accruesLeave('employee'))
  assert.ok(!accruesLeave('contractor'))
})

test('a change applies from its day; days before it keep the old type', () => {
  const p = person('employee', '2026-11-10', 'contractor') // 1099 until Nov 9, W-2 from Nov 10
  assert.equal(workerTypeOn(p, '2026-11-09'), 'contractor')
  assert.equal(workerTypeOn(p, '2026-11-10'), 'employee')
})

test('changing the type records the old one and defaults the day to today', () => {
  assert.deepEqual(workerTypeChange(person('employee'), 'contractor', null, '2026-11-07'), { workerType: 'contractor', workerTypeFrom: '2026-11-07', priorWorkerType: 'employee' })
  assert.deepEqual(workerTypeChange(person('contractor', '2026-11-07', 'employee'), 'contractor', '2026-11-01', '2026-11-07'), { workerType: 'contractor', workerTypeFrom: '2026-11-01', priorWorkerType: 'employee' })
  assert.deepEqual(workerTypeChange(null, 'contractor', null, '2026-11-07'), { workerType: 'contractor', workerTypeFrom: null, priorWorkerType: null })
})

test('only employee and contractor are worker types', () => {
  assert.ok(isWorkerType('employee') && isWorkerType('contractor'))
  assert.ok(!isWorkerType('1099') && !isWorkerType(undefined))
})
