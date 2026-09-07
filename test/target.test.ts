import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStateVector,
  project,
  classifyAge,
  isDisplayable,
  MAX_EXTRAPOLATION_S,
  type StateVector,
} from '../src/core/target.ts';
import { distanceBetween } from '../src/core/geo.ts';

const SERVER_TIME = 1_788_791_605;

/** A real shape of row, with the fields under test made explicit per case. */
function vector(overrides: Partial<{
  icao24: string; callsign: string | null; timePosition: number | null;
  lastContact: number; lon: number | null; lat: number | null;
  baroAltitude: number | null; onGround: boolean; velocity: number | null;
  trueTrack: number | null; verticalRate: number | null;
  geoAltitude: number | null; squawk: string | null; positionSource: number;
}> = {}): StateVector {
  const o = {
    icao24: '4aca81', callsign: 'NSZ56J  ', timePosition: SERVER_TIME,
    lastContact: SERVER_TIME, lon: 17.4829, lat: 57.8427, baroAltitude: 10_035.54,
    onGround: false, velocity: 210.59, trueTrack: 12.27, verticalRate: -3.9,
    geoAltitude: 10_325.1, squawk: '1000', positionSource: 0, ...overrides,
  };
  return [
    o.icao24, o.callsign, 'Sweden', o.timePosition, o.lastContact, o.lon, o.lat,
    o.baroAltitude, o.onGround, o.velocity, o.trueTrack, o.verticalRate, null,
    o.geoAltitude, o.squawk, false, o.positionSource,
  ];
}

/* ------------------------------------------------------------------ parsing */

test('a callsign is trimmed, and an empty one becomes null', () => {
  assert.equal(parseStateVector(vector(), SERVER_TIME).callsign, 'NSZ56J');
  assert.equal(parseStateVector(vector({ callsign: '        ' }), SERVER_TIME).callsign, null);
  assert.equal(parseStateVector(vector({ callsign: null }), SERVER_TIME).callsign, null);
});

test('age is measured against the server clock, not the reader', () => {
  const target = parseStateVector(vector({ timePosition: SERVER_TIME - 12 }), SERVER_TIME);
  assert.equal(target.ageAtFetch, 12);
});

test('a position from the future is clamped to zero rather than shown as ahead', () => {
  const target = parseStateVector(vector({ timePosition: SERVER_TIME + 5 }), SERVER_TIME);
  assert.equal(target.ageAtFetch, 0);
});

test('a null time_position falls back to last_contact', () => {
  const target = parseStateVector(
    vector({ timePosition: null, lastContact: SERVER_TIME - 40 }), SERVER_TIME);
  assert.equal(target.ageAtFetch, 40);
});

test('a vector with no coordinates yields no position', () => {
  const target = parseStateVector(vector({ lat: null, lon: null }), SERVER_TIME);
  assert.equal(target.position, null);
});

test('geometric altitude wins, barometric is the fallback', () => {
  assert.equal(parseStateVector(vector(), SERVER_TIME).altitude, 10_325.1);
  assert.equal(
    parseStateVector(vector({ geoAltitude: null }), SERVER_TIME).altitude, 10_035.54);
  assert.equal(
    parseStateVector(vector({ geoAltitude: null, baroAltitude: null }), SERVER_TIME).altitude, null);
});

test('position source is named, and an unknown code does not become ADS-B', () => {
  assert.equal(parseStateVector(vector({ positionSource: 0 }), SERVER_TIME).source, 'adsb');
  assert.equal(parseStateVector(vector({ positionSource: 2 }), SERVER_TIME).source, 'mlat');
  assert.equal(parseStateVector(vector({ positionSource: 9 }), SERVER_TIME).source, 'unknown');
});

/* --------------------------------------------------------------- freshness */

test('freshness bands are closed at their stated limits', () => {
  assert.equal(classifyAge(0), 'live');
  assert.equal(classifyAge(15), 'live');
  assert.equal(classifyAge(15.1), 'aging');
  assert.equal(classifyAge(60), 'aging');
  assert.equal(classifyAge(60.1), 'stale');
  assert.equal(classifyAge(300), 'stale');
  assert.equal(classifyAge(300.1), 'lost');
});

test('freshness advances with elapsed time even when no new data arrives', () => {
  const target = parseStateVector(vector({ timePosition: SERVER_TIME - 10 }), SERVER_TIME);
  assert.equal(project(target, 0).freshness, 'live');
  assert.equal(project(target, 20).freshness, 'aging');
  assert.equal(project(target, 120).freshness, 'stale');
  assert.equal(project(target, 600).freshness, 'lost');
});

/* -------------------------------------------------------------- projection */

test('a moving aircraft advances by speed times elapsed time', () => {
  const target = parseStateVector(vector({ velocity: 200, trueTrack: 0 }), SERVER_TIME);
  const after10s = project(target, 10);
  const moved = distanceBetween(target.position!, after10s.position!);
  assert.ok(Math.abs(moved - 2000) < 1, `expected 2000 m, got ${moved.toFixed(1)}`);
  assert.equal(after10s.estimated, true);
});

test('a vector that arrived already stale is projected from its own report time', () => {
  // 12 s old on arrival, drawn 3 s later: it has been flying for 15 s, not 3.
  const target = parseStateVector(
    vector({ velocity: 100, trueTrack: 90, timePosition: SERVER_TIME - 12 }), SERVER_TIME);
  const moved = distanceBetween(target.position!, project(target, 3).position!);
  assert.ok(Math.abs(moved - 1500) < 1, `expected 1500 m, got ${moved.toFixed(1)}`);
});

test('extrapolation stops at the horizon instead of inventing a position', () => {
  const target = parseStateVector(vector({ velocity: 250, trueTrack: 45 }), SERVER_TIME);
  const atHorizon = project(target, MAX_EXTRAPOLATION_S);
  const wellPast = project(target, MAX_EXTRAPOLATION_S + 600);

  assert.equal(atHorizon.frozen, false);
  assert.equal(wellPast.frozen, true);
  assert.ok(distanceBetween(atHorizon.position!, wellPast.position!) < 0.01,
    'a frozen target must not keep moving');
});

test('an aircraft on the ground is not dead-reckoned', () => {
  const target = parseStateVector(
    vector({ onGround: true, velocity: 9.26, trueTrack: 278 }), SERVER_TIME);
  const drawn = project(target, 25);
  assert.equal(drawn.estimated, false);
  assert.deepEqual(drawn.position, target.position);
});

test('a target with no speed or heading keeps its last known point', () => {
  const target = parseStateVector(
    vector({ velocity: null, trueTrack: null }), SERVER_TIME);
  const drawn = project(target, 20);
  assert.equal(drawn.estimated, false);
  assert.deepEqual(drawn.position, target.position);
});

test('altitude follows the vertical rate over the same interval', () => {
  const target = parseStateVector(
    vector({ geoAltitude: 3000, verticalRate: -10 }), SERVER_TIME);
  assert.equal(project(target, 20).altitude, 2800);
});

test('altitude is left alone when there is no vertical rate', () => {
  const target = parseStateVector(
    vector({ geoAltitude: 3000, verticalRate: null }), SERVER_TIME);
  assert.equal(project(target, 20).altitude, 3000);
});

test('negative elapsed time cannot rewind a target', () => {
  const target = parseStateVector(vector(), SERVER_TIME);
  assert.deepEqual(project(target, -30).position, project(target, 0).position);
});

/* ------------------------------------------------------------ displayability */

test('a lost target is dropped, a positionless one is never drawn', () => {
  const flying = parseStateVector(vector(), SERVER_TIME);
  assert.equal(isDisplayable(project(flying, 0)), true);
  assert.equal(isDisplayable(project(flying, 600)), false);

  const blind = parseStateVector(vector({ lat: null, lon: null }), SERVER_TIME);
  assert.equal(isDisplayable(project(blind, 0)), false);
});
