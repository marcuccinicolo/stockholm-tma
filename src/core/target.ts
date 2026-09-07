// Turning an OpenSky state vector into something a display can honestly draw.
//
// Two rules run through this file:
//
//   1. Age is measured against the server's clock, never the browser's. OpenSky
//      stamps every response with its own `time`; the client advances from
//      there using elapsed monotonic time. A viewer with a wrong system clock
//      therefore sees correct ages, not ages shifted by their own error.
//
//   2. The display extrapolates, but only so far. Dead reckoning assumes an
//      aircraft holds its heading and speed, which is true for a few seconds
//      and false for a minute. Past the horizon the position is frozen and the
//      target is marked instead of being quietly invented.

import { destination, type LatLon } from './geo.ts';

/** A raw row from OpenSky's `/states/all`, positional by design. */
export type StateVector = [
  icao24: string,
  callsign: string | null,
  originCountry: string,
  timePosition: number | null,
  lastContact: number,
  longitude: number | null,
  latitude: number | null,
  baroAltitude: number | null,
  onGround: boolean,
  velocity: number | null,
  trueTrack: number | null,
  verticalRate: number | null,
  sensors: number[] | null,
  geoAltitude: number | null,
  squawk: string | null,
  spi: boolean,
  positionSource: number,
  category?: number,
];

/**
 * Where a position came from. MLAT is computed by multilateration from several
 * receivers and is materially less precise than a broadcast ADS-B position —
 * so the display distinguishes them rather than drawing both as fact.
 */
export type PositionSource = 'adsb' | 'asterix' | 'mlat' | 'flarm' | 'unknown';

const POSITION_SOURCES: readonly PositionSource[] = ['adsb', 'asterix', 'mlat', 'flarm'];

/**
 * How much to trust what is on screen.
 *
 * `live` ends at 15 seconds because that is OpenSky's own threshold: it nulls
 * `time_position` when no position report has arrived within 15 seconds. The
 * boundary is taken from the data rather than chosen to look reassuring.
 */
export type Freshness = 'live' | 'aging' | 'stale' | 'lost';

export const FRESHNESS_LIMITS = {
  live: 15,
  aging: 60,
  stale: 300,
} as const;

/** How far ahead dead reckoning is allowed to run before the position freezes. */
export const MAX_EXTRAPOLATION_S = 30;

export function classifyAge(ageSeconds: number): Freshness {
  if (ageSeconds <= FRESHNESS_LIMITS.live) return 'live';
  if (ageSeconds <= FRESHNESS_LIMITS.aging) return 'aging';
  if (ageSeconds <= FRESHNESS_LIMITS.stale) return 'stale';
  return 'lost';
}

export interface Target {
  icao24: string;
  callsign: string | null;
  originCountry: string;
  position: LatLon | null;
  /** Metres. Geometric altitude preferred, barometric as fallback. Null on the ground or unknown. */
  altitude: number | null;
  onGround: boolean;
  /** Metres per second over the ground. */
  velocity: number | null;
  /** Degrees true, clockwise from north. */
  track: number | null;
  /** Metres per second, positive climbing. */
  verticalRate: number | null;
  squawk: string | null;
  source: PositionSource;
  /** Seconds between this aircraft's last position report and the server's own clock. */
  ageAtFetch: number;
}

const trimCallsign = (raw: string | null): string | null => {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : null;
};

/**
 * Reads one state vector as of `serverTime` — the `time` field of the response
 * that carried it, not the reader's clock.
 */
export function parseStateVector(row: StateVector, serverTime: number): Target {
  const [
    icao24, callsign, originCountry, timePosition, lastContact,
    longitude, latitude, baroAltitude, onGround, velocity,
    trueTrack, verticalRate, , geoAltitude, squawk, , positionSource,
  ] = row;

  const hasPosition = latitude !== null && longitude !== null;

  // `time_position` is null when no position has arrived recently; `last_contact`
  // still moves on any valid message, so it is the honest fallback for age.
  const positionTime = timePosition ?? lastContact;

  return {
    icao24,
    callsign: trimCallsign(callsign),
    originCountry,
    position: hasPosition ? { lat: latitude, lon: longitude } : null,
    altitude: geoAltitude ?? baroAltitude,
    onGround,
    velocity,
    track: trueTrack,
    verticalRate,
    squawk,
    source: POSITION_SOURCES[positionSource] ?? 'unknown',
    // Clamped at zero: a receiver slightly ahead of the server must not produce
    // a negative age, which would read as a position from the future.
    ageAtFetch: Math.max(0, serverTime - positionTime),
  };
}

export interface Projection {
  /** Where to draw it. Null when the target has no position at all. */
  position: LatLon | null;
  /** Metres, advanced by the vertical rate over the same interval. */
  altitude: number | null;
  /** Age in seconds at the moment being drawn. */
  age: number;
  freshness: Freshness;
  /** True when the position shown is dead-reckoned rather than reported. */
  estimated: boolean;
  /** True when extrapolation hit the horizon and the position stopped advancing. */
  frozen: boolean;
}

/**
 * Where a target should be drawn `elapsedSeconds` after the response arrived.
 *
 * `elapsedSeconds` must come from a monotonic source (`performance.now`), not
 * from wall-clock arithmetic — the point is to be immune to the viewer's clock.
 */
export function project(target: Target, elapsedSeconds: number): Projection {
  const elapsed = Math.max(0, elapsedSeconds);
  const age = target.ageAtFetch + elapsed;
  const freshness = classifyAge(age);

  if (target.position === null) {
    return { position: null, altitude: target.altitude, age, freshness, estimated: false, frozen: false };
  }

  // Without a speed and a heading there is nothing to extrapolate from. Showing
  // the last known point is honest; guessing a direction is not.
  const canExtrapolate =
    target.velocity !== null && target.track !== null && !target.onGround && target.velocity > 0;

  if (!canExtrapolate) {
    return {
      position: target.position,
      altitude: target.altitude,
      age,
      freshness,
      estimated: false,
      frozen: false,
    };
  }

  // Extrapolate from the last report, not from the moment of fetch: a vector
  // that was already 12 seconds old on arrival is 12 seconds further along.
  const projectedFor = Math.min(age, MAX_EXTRAPOLATION_S);
  const frozen = age > MAX_EXTRAPOLATION_S;

  const position = destination(target.position, target.track!, target.velocity! * projectedFor);
  const altitude =
    target.altitude !== null && target.verticalRate !== null
      ? target.altitude + target.verticalRate * projectedFor
      : target.altitude;

  return { position, altitude, age, freshness, estimated: projectedFor > 0, frozen };
}

/** Targets past the last freshness band are dropped rather than left on screen. */
export function isDisplayable(projection: Projection): boolean {
  return projection.freshness !== 'lost' && projection.position !== null;
}
