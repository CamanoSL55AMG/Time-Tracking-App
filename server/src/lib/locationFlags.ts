import { geoFlag } from './geo.js'

// Punches made without the phone's position, for the review screens (Art, 2026-11-13:
// "If the user declines that I need to know that."). Kept apart from the database so it
// can be tested on its own.

export interface LocationPunch {
  id: string
  personId: string
  clockIn: Date
  clockOut: Date | null
  inGeoStatus: string | null
  outGeoStatus: string | null
  source: string
}

export interface LocationFlag {
  punchId: string
  personId: string
  side: 'in' | 'out'
  at: Date
  status: string
  code: 'location_declined' | 'no_location'
}

/**
 * One flag per tap that went without a position. A switch (one segment ends the instant
 * the next one starts) is a single tap, so only the new segment's start is flagged; an
 * end is flagged only when it is a real clock-out.
 */
export function locationFlags(punches: LocationPunch[]): LocationFlag[] {
  const starts = new Set(punches.map((p) => `${p.personId}|${p.clockIn.getTime()}`))
  const out: LocationFlag[] = []
  for (const p of punches) {
    const inFlag = geoFlag(p.inGeoStatus)
    if (inFlag) {
      out.push({ punchId: p.id, personId: p.personId, side: 'in', at: p.clockIn, status: p.inGeoStatus!, code: inFlag === 'declined' ? 'location_declined' : 'no_location' })
    }
    const outFlag = geoFlag(p.outGeoStatus)
    if (outFlag && p.clockOut && !starts.has(`${p.personId}|${p.clockOut.getTime()}`)) {
      out.push({ punchId: p.id, personId: p.personId, side: 'out', at: p.clockOut, status: p.outGeoStatus!, code: outFlag === 'declined' ? 'location_declined' : 'no_location' })
    }
  }
  return out
}

/** Why there is no position, in plain words. */
export function noLocationReason(status: string, byLead: boolean): string {
  const phone = byLead ? "the crew lead's phone" : 'the phone'
  switch (status) {
    case 'denied':
      return `location was declined on ${phone}`
    case 'timeout':
      return `${phone} could not find its position in time`
    case 'unavailable':
      return `${phone} could not find its position`
    default:
      return `${phone} or its browser cannot share location`
  }
}
