// Which jobs fold under "Archived" in Logbook's project lists (Art, 2026-11-09:
// "remove all the old projects and move them to archived in that same list").
//
// Nothing is deleted or closed by this. An archived project that is still open for
// time can be picked from the Archived group, and every hour on it stays where it is.
//
// A project stays on top when either is true:
//   - Jetbuilt has it at Contract, Install or Review (won work), or
//   - someone punched on it in the last RECENT_DAYS days.
// Everything else that is a project goes under Archived: open proposals nobody has
// charged time to lately, and old projects. Jobs closed to new time (active false)
// are always archived. Service calls, site visits, shop, repair and office jobs are
// never archived while they are open.

export const RECENT_DAYS = 60
export const WON_STAGES = new Set(['CONTRACT', 'INSTALL', 'REVIEW'])

export interface ArchiveInput {
  kind: string
  active: boolean
  stage?: string | null
  lastPunchAt?: Date | string | null
}

export function isArchived(job: ArchiveInput, now: Date = new Date()): boolean {
  if (!job.active) return true
  if (job.kind !== 'project') return false
  if (WON_STAGES.has(String(job.stage ?? '').trim().toUpperCase())) return false
  if (job.lastPunchAt) {
    const last = new Date(job.lastPunchAt).getTime()
    if (Number.isFinite(last) && now.getTime() - last <= RECENT_DAYS * 86_400_000) return false
  }
  return true
}
