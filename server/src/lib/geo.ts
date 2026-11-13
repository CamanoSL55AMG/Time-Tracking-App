export interface GeoStamp {
  lat: number
  lng: number
  accuracyM?: number
}

export interface Fence {
  lat: number
  lng: number
  radiusM: number
}

/** Great-circle distance in metres. */
export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000
  const rad = (deg: number) => (deg * Math.PI) / 180
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(h))
}

/** true / false when it can be told; null without a fence or a position. A reading
 *  counts as inside when its accuracy circle reaches the fence. */
export function insideFence(geo: GeoStamp | null | undefined, fence: Fence | null | undefined): boolean | null {
  if (!geo || !fence) return null
  return distanceM(geo, fence) <= fence.radiusM + (geo.accuracyM ?? 0)
}

/** Accept a position only if it is a plausible coordinate pair. */
export function parseGeo(input: unknown): GeoStamp | null {
  if (!input || typeof input !== 'object') return null
  const g = input as Record<string, unknown>
  const lat = Number(g.lat)
  const lng = Number(g.lng)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null
  const acc = Number(g.accuracyM)
  return { lat, lng, accuracyM: Number.isFinite(acc) && acc >= 0 ? acc : undefined }
}

// ─── Whether the phone shared its position ─────────────────────────────────
// Art, 2026-11-13: "If the user declines that I need to know that." The punch always
// goes through; the answer the phone gave is kept on the punch and flagged for review.

export const GEO_STATUSES = ['captured', 'denied', 'unavailable', 'timeout', 'unsupported'] as const
export type GeoStatus = (typeof GEO_STATUSES)[number]
const NOT_CAPTURED = new Set<string>(['denied', 'unavailable', 'timeout', 'unsupported'])

/**
 * The status to store with a punch. A real position always wins ("captured"). Without
 * one, only a status the phone reported for a failed read is kept; a sender that says
 * nothing (an integration, an old copy of the app) leaves it unknown (null), and
 * "captured" with no position is not believed.
 */
export function resolveGeoStatus(geo: GeoStamp | null | undefined, raw: unknown): GeoStatus | null {
  if (geo) return 'captured'
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  return NOT_CAPTURED.has(s) ? (s as GeoStatus) : null
}

/** How a punch's location answer shows for a reviewer; null when there is nothing to flag. */
export function geoFlag(status: string | null | undefined): 'declined' | 'missing' | null {
  if (status === 'denied') return 'declined'
  if (status && NOT_CAPTURED.has(status)) return 'missing'
  return null
}
