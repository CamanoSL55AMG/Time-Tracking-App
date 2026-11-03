import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laborCsv, lineIdOf, splitWorkweek, type LaborLine } from './payroll.js'

const seg = (startIso: string, hours: number, jobId = 'job-a', phaseId: string | null = 'install') => ({
  personId: 'p1',
  jobId,
  phaseId,
  clockIn: new Date(startIso),
  clockOut: new Date(new Date(startIso).getTime() + hours * 3_600_000),
})

const hrs = (s: number) => s / 3600

test('a 40-hour week is all regular', () => {
  const week = [0, 1, 2, 3, 4].map((d) => seg(`2026-11-0${2 + d}T15:00:00Z`, 8))
  const out = splitWorkweek(week, 40)
  assert.equal(out.reduce((t, s) => t + hrs(s.regularSeconds), 0), 40)
  assert.equal(out.reduce((t, s) => t + s.overtimeSeconds, 0), 0)
})

test('hours past 40 in the week are overtime, on the segments worked last', () => {
  const week = [0, 1, 2, 3, 4].map((d) => seg(`2026-11-0${2 + d}T15:00:00Z`, 9)) // 45 h
  const out = splitWorkweek(week, 40)
  assert.deepEqual(out.map((s) => [hrs(s.regularSeconds), hrs(s.overtimeSeconds)]), [[9, 0], [9, 0], [9, 0], [9, 0], [4, 5]])
})

test('order worked decides, not the order given', () => {
  const late = seg('2026-11-06T15:00:00Z', 10, 'job-b')
  const early = [0, 1, 2, 3].map((d) => seg(`2026-11-0${2 + d}T15:00:00Z`, 10))
  const out = splitWorkweek([late, ...early], 40)
  const last = out[out.length - 1]
  assert.equal(last.segment.jobId, 'job-b')
  assert.equal(hrs(last.overtimeSeconds), 10)
})

test('a long day alone is not overtime (no daily overtime in Washington)', () => {
  const out = splitWorkweek([seg('2026-11-02T14:00:00Z', 14)], 40)
  assert.equal(hrs(out[0].regularSeconds), 14)
  assert.equal(out[0].overtimeSeconds, 0)
})

test('exempt people and a threshold of 0 get no overtime', () => {
  const week = [0, 1, 2, 3, 4].map((d) => seg(`2026-11-0${2 + d}T15:00:00Z`, 10))
  for (const out of [splitWorkweek(week, 40, true), splitWorkweek(week, 0)]) {
    assert.equal(out.reduce((t, s) => t + s.overtimeSeconds, 0), 0)
    assert.equal(out.reduce((t, s) => t + hrs(s.regularSeconds), 0), 50)
  }
})

test('line ids are stable and differ by phase', () => {
  assert.equal(lineIdOf('p1', '2026-11-02', 'j1', 'ph1'), lineIdOf('p1', '2026-11-02', 'j1', 'ph1'))
  assert.notEqual(lineIdOf('p1', '2026-11-02', 'j1', 'ph1'), lineIdOf('p1', '2026-11-02', 'j1', 'ph2'))
  assert.notEqual(lineIdOf('p1', '2026-11-02', 'j1', null), lineIdOf('p1', '2026-11-02', 'j1', 'ph1'))
})

test('csv has the import columns and quotes what needs quoting', () => {
  const line: LaborLine = {
    lineId: 'abc', personId: 'p1', personEmail: 'tech@example.com', personName: 'Pat, Tech', overtimeExempt: false,
    date: '2026-11-02', weekStart: '2026-11-02', jobId: 'j1', jobCode: 'P-1001', jobName: '=HYPERLINK("x")', jobKind: 'project',
    phaseKey: 'install', phaseName: 'Install', laborCategory: 'install', regularHours: 8, overtimeHours: 1.5, hours: 9.5, segments: 2,
  }
  const [head, row] = laborCsv([line]).trim().split('\r\n')
  assert.equal(head, 'line_id,employee_email,employee_name,date,week_start,job_code,job_name,job_kind,phase,labor_category,regular_hours,overtime_hours,hours')
  assert.equal(row, 'abc,tech@example.com,"Pat, Tech",2026-11-02,2026-11-02,P-1001,"\'=HYPERLINK(""x"")",project,Install,install,8.00,1.50,9.50')
})
