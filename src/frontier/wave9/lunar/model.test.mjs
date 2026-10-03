/**
 * Wave 9 — Lunar ephemeris ticker model tests (R2-21).
 * Pure model over synthetic docs; the ephemeris math is pinned in
 * server/providers/wave9/lunar.test.mjs against the independent python
 * cross-check.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine, eventCount } from './model.js';

const DOC = {
  date: '2026-10-03T12:00:00.000Z',
  phase: { name: 'Last Quarter', illumination: 0.507, elongationDeg: 90.8, waxing: false },
  distanceKm: 363418,
  perigean: true,
  subLunar: { lat: -5.3, lon: 120.4 },
  upcoming: [
    { type: 'Last Quarter', date: '2026-10-03T13:32:20.722Z', daysAway: 0.1, distanceKm: 363457, perigean: true },
    { type: 'New Moon', date: '2026-10-10T15:30:00.000Z', daysAway: 7.1, distanceKm: 388958, perigean: false },
  ],
  observer: { lat: 37.28, lon: -80.41 },
  riseSet: {
    moonrise: '2026-10-03T03:16:03.778Z',
    moonset: '2026-10-03T19:05:00.194Z',
    events: [
      { type: 'moonrise', time: '2026-10-03T03:16:03.778Z' },
      { type: 'moonset', time: '2026-10-03T19:05:00.194Z' },
    ],
    reason: null,
  },
  source: 'computed',
  generatedAt: '2026-10-03T12:00:00.000Z',
  honesty: { computation: 'COMPUTED GEOMETRY' },
};

test('ROUTE is /api/moon', () => {
  assert.equal(ROUTE, '/api/moon');
});

test('valueLine names the phase, illumination and next event', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('Last Quarter'), line);
  assert.ok(line.includes('50.7%'), line);
  assert.ok(line.includes('Last Quarter in 0.1d'), line);
});

test('valueLine degrades honestly on unavailable docs', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({}), null);
});

test('detailLine covers phase, distance, rise/set, next event, honesty', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('Last Quarter'), line);
  assert.ok(line.includes('363,418 km'), line);
  assert.ok(line.includes('moonrise 03:16'), line);
  assert.ok(line.includes('moonset 19:05'), line);
  assert.ok(line.includes('New Moon 2026-10-10'), line);
  assert.ok(line.includes('Computed geometry'), line);
});

test('eventCount reads the upcoming list', () => {
  assert.equal(eventCount(DOC), 2);
  assert.equal(eventCount({}), null);
});
