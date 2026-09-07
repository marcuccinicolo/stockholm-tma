import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  destination,
  distanceBetween,
  bearingDelta,
  normaliseLongitude,
  EARTH_RADIUS_M,
} from '../src/core/geo.ts';

const ARLANDA = { lat: 59.6519, lon: 17.9186 };

/** One degree of latitude on the mean sphere, in metres. */
const ONE_DEGREE_M = (Math.PI / 180) * EARTH_RADIUS_M;

test('travelling due north increases latitude by the expected degrees', () => {
  const north = destination(ARLANDA, 0, ONE_DEGREE_M);
  assert.ok(Math.abs(north.lat - (ARLANDA.lat + 1)) < 1e-9);
  assert.ok(Math.abs(north.lon - ARLANDA.lon) < 1e-9);
});

test('travelling due south is the inverse of travelling due north', () => {
  const there = destination(ARLANDA, 0, 50_000);
  const back = destination(there, 180, 50_000);
  assert.ok(distanceBetween(back, ARLANDA) < 0.01);
});

test('due east at the equator covers a full degree of longitude', () => {
  const east = destination({ lat: 0, lon: 0 }, 90, ONE_DEGREE_M);
  assert.ok(Math.abs(east.lat) < 1e-9);
  assert.ok(Math.abs(east.lon - 1) < 1e-9);
});

test('a degree of longitude shrinks with latitude', () => {
  // At 60°N a degree of longitude is half its equatorial length, so the same
  // eastward distance moves an aircraft over Arlanda twice as far in longitude
  // as one over the equator. Getting this wrong is the classic flat-map bug.
  const atEquator = destination({ lat: 0, lon: 0 }, 90, 100_000);
  const atArlanda = destination({ lat: 60, lon: 0 }, 90, 100_000);
  const ratio = atArlanda.lon / atEquator.lon;
  assert.ok(ratio > 1.9 && ratio < 2.1, `expected ~2, got ${ratio}`);
});

test('zero distance returns the origin unchanged', () => {
  assert.deepEqual(destination(ARLANDA, 137, 0), ARLANDA);
});

test('a track across the antimeridian stays inside -180..180', () => {
  const crossed = destination({ lat: 0, lon: 179.9 }, 90, 40_000);
  assert.ok(crossed.lon < 0, `expected a wrap to negative, got ${crossed.lon}`);
  assert.ok(crossed.lon >= -180 && crossed.lon <= 180);
});

test('normaliseLongitude wraps without drifting', () => {
  assert.equal(normaliseLongitude(0), 0);
  assert.equal(normaliseLongitude(180), 180);
  assert.equal(normaliseLongitude(-180), -180);
  assert.equal(normaliseLongitude(190), -170);
  assert.equal(normaliseLongitude(-190), 170);
  assert.equal(normaliseLongitude(540), 180);
});

test('distance is symmetric and zero for a point against itself', () => {
  const other = { lat: 59.3293, lon: 18.0686 };
  assert.equal(distanceBetween(ARLANDA, ARLANDA), 0);
  assert.ok(Math.abs(distanceBetween(ARLANDA, other) - distanceBetween(other, ARLANDA)) < 1e-9);
});

test('Arlanda to Bromma is about 35 km', () => {
  const bromma = { lat: 59.3544, lon: 17.9416 };
  const km = distanceBetween(ARLANDA, bromma) / 1000;
  assert.ok(km > 32 && km < 36, `expected ~33 km, got ${km.toFixed(1)}`);
});

test('bearingDelta takes the short way round north', () => {
  assert.equal(bearingDelta(350, 10), 20);
  assert.equal(bearingDelta(10, 350), -20);
  assert.equal(bearingDelta(0, 0), 0);
  assert.equal(bearingDelta(0, 180), 180);
  assert.equal(bearingDelta(180, 0), 180);
});
