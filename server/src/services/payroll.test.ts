import { test } from 'node:test'
import assert from 'node:assert/strict'
import { laborCsv, lineIdOf, previousSemimonthlyPeriod, semimonthlyPeriod, splitMixedWeek, splitWorkweek, type LaborLine } from './payroll.js'

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

test('pay periods run the 1st to the 15th and the 16th to month end', () => {
  assert.deepEqual(semimonthlyPeriod('2026-11-04'), { from: '2026-11-01', to: '2026-11-15' })
  assert.deepEqual(semimonthlyPeriod('2026-11-16'), { from: '2026-11-16', to: '2026-11-30' })
  assert.deepEqual(semimonthlyPeriod('2027-02-20'), { from: '2027-02-16', to: '2027-02-28' })
  assert.deepEqual(previousSemimonthlyPeriod('2026-11-04'), { from: '2026-10-16', to: '2026-10-31' })
  assert.deepEqual(previousSemimonthlyPeriod('2027-01-10'), { from: '2026-12-16', to: '2026-12-31' })
})

test('a week that crosses a pay period end: the first period keeps the split it earned, the rest lands in the next', () => {
  // Mon Dec 14 to Fri Dec 18 2026, 10 h a day; the pay period ends Tue Dec 15.
  const week = [14, 15, 16, 17, 18].map((d) => seg(`2026-12-${d}T16:00:00Z`, 10))
  const whole = splitWorkweek(week, 40).map((s) => [hrs(s.regularSeconds), hrs(s.overtimeSeconds)])
  assert.deepEqual(whole, [[10, 0], [10, 0], [10, 0], [10, 0], [0, 10]])
  // Worked out on the 16th with only Mon and Tue on the books, the split is the same,
  // so paying the first period early never has to be taken back.
  const soFar = splitWorkweek(week.slice(0, 2), 40).map((s) => [hrs(s.regularSeconds), hrs(s.overtimeSeconds)])
  assert.deepEqual(soFar, whole.slice(0, 2))
})

test('approvers can sign off any time: the day to approve through', async () => {
  const { resolveThrough } = await import('./timesheets.js')
  const week = '2026-11-09' // Mon Nov 9 to Sun Nov 15
  // Mid-week with nothing given: through yesterday.
  assert.deepEqual(resolveThrough(week, '2026-11-12'), { through: '2026-11-11' })
  // Once the week is over: the whole week.
  assert.deepEqual(resolveThrough(week, '2026-11-16'), { through: '2026-11-15' })
  // A chosen day, like the 15th, once it is over.
  assert.deepEqual(resolveThrough('2026-11-16', '2026-12-01', '2026-11-16'), { through: '2026-11-16' })
  // A day not over yet, a day outside the week, and a Monday with nothing over.
  assert.equal((resolveThrough(week, '2026-11-12', '2026-11-12') as { code: string }).code, 'day_not_over')
  assert.equal((resolveThrough(week, '2026-11-20', '2026-11-16') as { code: string }).code, 'bad_through')
  assert.equal((resolveThrough(week, '2026-11-09') as { code: string }).code, 'nothing_to_approve')
})

test('a part-week approval covers only its days', async () => {
  const { approvalCovers, approvedThroughOf } = await import('./timesheets.js')
  const part = { status: 'approved', approvedThrough: '2026-11-30', weekStart: '2026-11-30' }
  assert.equal(approvalCovers(part, '2026-11-30'), true)
  assert.equal(approvalCovers(part, '2026-12-01'), false)
  // An approval from before this change has no day: it covers the whole week.
  assert.equal(approvedThroughOf({ status: 'approved', approvedThrough: null, weekStart: '2026-11-09' }), '2026-11-15')
  assert.equal(approvedThroughOf({ status: 'signed', approvedThrough: null, weekStart: '2026-11-09' }), null)
})

// ─── 1099 contractors ───────────────────────────────────────────────────────

test('contractor hours are all regular and do not push an employee week into overtime', () => {
  // Mon to Thu as an employee, 10 h a day (40 h), then Fri as a contractor, 10 h.
  const week = [2, 3, 4, 5, 6].map((d) => seg(`2026-11-0${d}T15:00:00Z`, 10))
  const typeOf = (s: { clockIn: Date }) => (s.clockIn.getUTCDate() === 6 ? ('contractor' as const) : ('employee' as const))
  const out = splitMixedWeek(week, typeOf, 40)
  assert.deepEqual(
    out.map((s) => [s.workerType, hrs(s.regularSeconds), hrs(s.overtimeSeconds)]),
    [['employee', 10, 0], ['employee', 10, 0], ['employee', 10, 0], ['employee', 10, 0], ['contractor', 10, 0]],
  )
})

test('a contractor working 50 hours gets no overtime', () => {
  const week = [2, 3, 4, 5, 6].map((d) => seg(`2026-11-0${d}T15:00:00Z`, 10))
  const out = splitMixedWeek(week, () => 'contractor', 40)
  assert.equal(out.reduce((t, s) => t + s.overtimeSeconds, 0), 0)
  assert.equal(out.reduce((t, s) => t + hrs(s.regularSeconds), 0), 50)
})

test('all-employee weeks split exactly as before', () => {
  const week = [0, 1, 2, 3, 4].map((d) => seg(`2026-11-0${2 + d}T15:00:00Z`, 9))
  const before = splitWorkweek(week, 40).map((s) => [s.regularSeconds, s.overtimeSeconds])
  const after = splitMixedWeek(week, () => 'employee', 40).map((s) => [s.regularSeconds, s.overtimeSeconds])
  assert.deepEqual(after, before)
})

test('csv adds worker_type last only when contractors are on', () => {
  const line: LaborLine = {
    lineId: 'abc', personId: 'p1', personEmail: 'sub@example.com', personName: 'Sam Sub', overtimeExempt: false,
    date: '2026-11-02', weekStart: '2026-11-02', jobId: 'j1', jobCode: 'P-1001', jobName: 'Job', jobKind: 'project',
    phaseKey: 'install', phaseName: 'Install', laborCategory: 'install', regularHours: 8, overtimeHours: 0, hours: 8, segments: 1,
    workerType: 'contractor',
  }
  assert.ok(!laborCsv([line]).includes('worker_type'))
  const [head, row] = laborCsv([line], { contractors: true }).trim().split('\r\n')
  assert.ok(head.endsWith(',hours,worker_type'))
  assert.ok(row.endsWith(',8.00,contractor'))
})

test('approved leave follows the labor rows: its own job code, all regular, never overtime', () => {
  const leave = [{ lineId: 'leave-abcd1234-2026-11-16', personEmail: 'pat@example.com', personName: 'Pat Example', date: '2026-11-16', weekStart: '2026-11-16', leaveTypeKey: 'vacation', leaveTypeName: 'Vacation', hours: 8 }]
  const rows = laborCsv([], { leave }).trim().split('\r\n')
  assert.equal(rows.length, 2)
  assert.equal(rows[1], 'leave-abcd1234-2026-11-16,pat@example.com,Pat Example,2026-11-16,2026-11-16,LEAVE-VACATION,Vacation,leave,Vacation,leave,8.00,0.00,8.00')
  const withType = laborCsv([], { leave, contractors: true }).trim().split('\r\n')
  assert.ok(withType[1].endsWith(',8.00,0.00,8.00,employee'))
})
