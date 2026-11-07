import { Router } from 'express'
import { route, str } from '../api.js'
import { ApiError } from '../errors.js'
import { requireScope } from '../auth/middleware.js'
import { config } from '../config.js'
import { laborCsv, laborExport, previousSemimonthlyPeriod, semimonthlyPeriod } from '../services/payroll.js'
import { prisma } from '../db.js'
import { localDate } from '../lib/time.js'

export const payrollRouter = Router()

route(
  payrollRouter,
  {
    method: 'get',
    path: '/payroll/labor',
    tag: 'Payroll',
    summary:
      'Approved hours for a pay period, for payroll: one line per person, day, job and phase with regular and overtime hours. ' +
      'Weeks not approved yet are listed under notReady. Off unless PAYROLL_EXPORT_ENABLED=true.',
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
    if (str(req.query.format, 10).toLowerCase() === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8')
      res.setHeader('Content-Disposition', `attachment; filename="labor-${result.from}-to-${result.to}.csv"`)
      res.status(200).send(laborCsv(result.lines, { contractors }))
      return
    }
    return result
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
