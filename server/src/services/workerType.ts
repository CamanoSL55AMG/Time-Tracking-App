// W-2 employees and 1099 contractors (CONTRACTORS_ENABLED, off by default).
//
// Contractors punch and log expenses like everyone else. What changes is how
// their hours are paid: AIC Accounting pays them as a vendor (no withholding, no
// employer payroll taxes, not on a W-2 or the state quarterly hours report), so
// the payroll export marks their lines and gives them no overtime split. They
// accrue no sick or vacation leave: leave accrual must skip hours for which
// `accruesLeave(workerTypeOn(...))` is false.
//
// A person has one type at a time. When it changes, the day it changes is kept
// (workerTypeFrom) with the type before it (priorWorkerType), so a pay period
// that spans the change pays each day the right way.

export const WORKER_TYPES = ['employee', 'contractor'] as const
export type WorkerType = (typeof WORKER_TYPES)[number]

export const isWorkerType = (v: unknown): v is WorkerType => typeof v === 'string' && (WORKER_TYPES as readonly string[]).includes(v)

export interface HasWorkerType {
  workerType: string
  workerTypeFrom: string | null
  priorWorkerType: string | null
}

const asType = (v: string | null | undefined): WorkerType => (v === 'contractor' ? 'contractor' : 'employee')

/** The person's type on a day (YYYY-MM-DD, company time). */
export function workerTypeOn(p: HasWorkerType, date: string): WorkerType {
  if (p.workerTypeFrom && date < p.workerTypeFrom) return asType(p.priorWorkerType)
  return asType(p.workerType)
}

/** Overtime and leave are employment rules; contractors get neither. */
export const accruesLeave = (t: WorkerType) => t === 'employee'
export const earnsOvertime = (t: WorkerType) => t === 'employee'

/**
 * The fields to save when someone's type is set. Changing the type records the
 * day it changes (default today) and the type before it; setting the same type
 * only moves its start day when one is given.
 */
export function workerTypeChange(
  existing: HasWorkerType | null,
  next: WorkerType,
  from: string | null,
  today: string,
): { workerType: WorkerType; workerTypeFrom: string | null; priorWorkerType: string | null } {
  if (!existing) return { workerType: next, workerTypeFrom: from, priorWorkerType: null }
  const current = asType(existing.workerType)
  if (current === next) {
    return { workerType: next, workerTypeFrom: from ?? existing.workerTypeFrom, priorWorkerType: existing.priorWorkerType }
  }
  return { workerType: next, workerTypeFrom: from ?? today, priorWorkerType: current }
}
