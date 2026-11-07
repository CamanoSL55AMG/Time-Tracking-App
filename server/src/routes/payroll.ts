import { Router } from 'express'
import { route, str } from '../api.js'
import { ApiError } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { config } from '../config.js'
import { laborCsv, laborExport, previousSemimonthlyPeriod, semimonthlyPeriod } from '../services/payroll.js'
import { prisma } from '../db.js'
import { localDate } from '../lib/time.js'
import { leaveForPayroll } from '../services/leave.js'

export const payrollRouter = Router()

route(
  payrollRouter,
  {
    method: 'get',
    path: '/payroll/labor',
    tag: 'Payroll',
    summary:
      'Approved hours for a pay period, for payroll: one line per person, day, job and phase with regular and overtime hours. ' +
      'Weeks not approved yet are listed under notReady. Off unless PAYROLL_EXPORT_ENABLED=true. ' +
      'With LEAVE_ENABLED=true, approved paid leave comes too: leaveLines (and leave rows in the CSV, job_kind "leave"), leaveHours on each total, and requests still waiting under leavePending.',
    access: ['payroll:read'],
    query: {
      from: 'First day of the pay period, YYYY-MM-DD (company time)',
      to: 'Last day of the pay period, YYYY-MM-DD, inclusive',
      format: 'json (default) or csv',
    },
  },
  async (req, res) => {
    const auth = requireScope(req, 'payroll:read')
    if (!config.payrollExportEnabled) {
      throw new ApiError(403, 'payroll_export_off', 'The payroll labor export is turned off. Set PAYROLL_EXPORT_ENABLED=true in server/.env and restart to turn it on.')
    }
    const from = str(req.query.from, 10)
    const to = str(req.query.to, 10) || from
    const contractors = config.contractorsEnabled
    const result = await laborExport(auth.companyId, from, to, { contractors })
    const leave = config.leaveEnabled ? await leaveForPayroll(auth.companyId, result.from, result.to) : null
    if (str(req.query.format, 10).toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="labor-${result.from}-to-${result.to}.csv"`)
      res.status(200).send(laborCsv(result.lines, { contractors, leave: leave?.lines ?? [] }))
      return
    }
    if (!leave) return result
    // Leave adds to each person's totals (and adds people who only took leave).
    const r2 = (n: number) => Math.round(n * 100) / 100
    const totals = new Map(result.totals.map((t) => [t.personId, { ...t, leaveHours: 0 }]))
    for (const l of leave.lines) {
      const t = totals.get(l.personId) ?? { personId: l.personId, personEmail: l.personEmail, personName: l.personName, regularHours: 0, overtimeHours: 0, hours: 0, leaveHours: 0 }
      t.leaveHours = r2(t.leaveHours + l.hours)
      totals.set(l.personId, t)
    }
    return {
      ...result,
      totals: [...totals.values()].sort((a, b) => a.personName.localeCompare(b.personName)),
      leaveLines: leave.lines,
      leavePending: leave.pending,
    }
  },
)

route(
  payrollRouter,
  {
    method: 'get',
    path: '/payroll/periods',
    tag: 'Payroll',
    summary: 'The pay periods payroll runs on (the 1st to the 15th, and the 16th to month end): the one today is in, and the one before it.',
    access: ['payroll:read'],
  },
  async (req) => {
    const auth = requireScope(req, 'payroll:read')
    const company = await prisma.company.findUniqueOrThrow({ where: { id: auth.companyId } })
    const today = localDate(new Date(), company.timezone)
    return {
      today,
      exportEnabled: config.payrollExportEnabled,
      contractorsEnabled: config.contractorsEnabled,
      current: semimonthlyPeriod(today),
      previous: previousSemimonthlyPeriod(today),
    }
  },
)
