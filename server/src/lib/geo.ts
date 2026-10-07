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
