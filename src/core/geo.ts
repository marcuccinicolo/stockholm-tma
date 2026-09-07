// Spherical geometry, as plain maths. No DOM, no network, no framework —
// everything here is a pure function so it can be tested as arithmetic.

/** IUGG mean Earth radius, in metres. */
export const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLon {
  /** Degrees north, -90..90. */
  lat: number;
  /** Degrees east, -180..180. */
  lon: number;
}

const toRad = (deg: number): number => (deg * Math.PI) / 180;
const toDeg = (rad: number): number => (rad * 180) / Math.PI;

/** Wraps a longitude into -180..180 so a track across the antimeridian stays valid. */
export function normaliseLongitude(lon: number): number {
  const wrapped = ((lon + 180) % 360 + 360) % 360 - 180;
  // ((-180 % 360) + 360) % 360 - 180 === -180, but 180 should survive as 180.
  return wrapped === -180 && lon > 0 ? 180 : wrapped;
}

/**
 * The point reached by travelling `distanceM` from `from` along a constant
 * `bearingDeg` (true, clockwise from north) on a great circle.
 *
 * This is the whole of dead reckoning: given where something was, how fast it
 * was going and which way it was pointing, say where it is now.
 */
export function destination(from: LatLon, bearingDeg: number, distanceM: number): LatLon {
  if (distanceM === 0) return { lat: from.lat, lon: from.lon };

  const angular = distanceM / EARTH_RADIUS_M;
  const bearing = toRad(bearingDeg);
  const lat1 = toRad(from.lat);
  const lon1 = toRad(from.lon);

  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinAngular = Math.sin(angular);
  const cosAngular = Math.cos(angular);

  const sinLat2 = sinLat1 * cosAngular + cosLat1 * sinAngular * Math.cos(bearing);
  const lat2 = Math.asin(sinLat2);

  const y = Math.sin(bearing) * sinAngular * cosLat1;
  const x = cosAngular - sinLat1 * sinLat2;
  const lon2 = lon1 + Math.atan2(y, x);

  return { lat: toDeg(lat2), lon: normaliseLongitude(toDeg(lon2)) };
}

/** Great-circle distance in metres between two points (haversine). */
export function distanceBetween(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Shortest signed difference between two bearings, in degrees (-180..180].
 * Used to turn an aircraft smoothly through north instead of spinning it 350°
 * the long way round.
 */
export function bearingDelta(fromDeg: number, toDeg_: number): number {
  const diff = ((toDeg_ - fromDeg + 540) % 360) - 180;
  return diff === -180 ? 180 : diff;
}
