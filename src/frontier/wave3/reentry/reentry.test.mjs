/**
 * Reentry frontend tests — REAL assertions: SGP4 ground tracks, coarse
 * land heuristic on known points, uncertainty-band shape, timing strings,
 * and source orchestration. index.js (Cesium/DOM) is not imported.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isLandApprox,
  coerceCandidate,
  propagateGeodetic,
  groundTrack,
  uncertaintyBand,
  overflightAlert,
  formatTiming,
  rankCandidates,
  URGENCY_STYLE,
} from './model.js';
import { createReentrySource } from './source.js';

function checksum68(line68) {
  let sum = 0;
  for (const c of line68) {
    if (c >= '0' && c <= '9') sum += Number(c);
    else if (c === '-') sum += 1;
  }
  return String(sum % 10);
}
function makeTle() {
  const l1 = '1 25544U 98067A   26270.50000000  .00002174  00000-0  12345-6 0  999'.padEnd(68, ' ');
  const l2 = '2 25544  51.6400 208.9163 0006703  69.9862  25.2906 15.72125391    01'.padEnd(68, ' ');
  return { name: 'ISS (ZARYA)', line1: l1 + checksum68(l1), line2: l2 + checksum68(l2) };
}

const RAW = {
  id: 're-25544', name: 'ISS (ZARYA)', noradId: '25544',
  tcaUtc: '2026-10-02T00:00:00.000Z',
  tcaDays: 5.0, windowHours: 48, daysLow: 3.75, daysHigh: 6.25,
  urg: 'watch', meanMotion: 15.72, tle: makeTle(),
};

test('isLandApprox: known points classify correctly (heuristic)', () => {
  assert.equal(isLandApprox(37.7, -122.4), true); // San Francisco
  assert.equal(isLandApprox(51.5, 0), true); // London
  assert.equal(isLandApprox(-33.9, 151.2), true); // Sydney
  assert.equal(isLandApprox(-77, 0), true); // Antarctica
  assert.equal(isLandApprox(0, -140), false); // mid-Pacific
  assert.equal(isLandApprox(30, -40), false); // mid-Atlantic
});

test('coerceCandidate keeps a good candidate, drops garbage', () => {
  const c = coerceCandidate(RAW);
  assert.equal(c.tcaDays, 5.0);
  assert.equal(c.urg, 'watch');
  assert.equal(c.tle.line1[0], '1');
  assert.equal(coerceCandidate({ ...RAW, tcaDays: -1 }), null);
  assert.equal(coerceCandidate({ ...RAW, urg: 'apocalypse' }).urg, 'nominal');
  assert.equal(coerceCandidate(null), null);
});

test('propagateGeodetic returns a sane fix; junk TLE returns null', () => {
  const p = propagateGeodetic(makeTle(), Date.parse('2026-09-27T12:00:00.000Z'));
  assert.ok(p);
  assert.ok(Math.abs(p.lat) <= 51.7);
  assert.ok(p.altKm > 300 && p.altKm < 400);
  assert.equal(propagateGeodetic({ line1: 'x', line2: 'y' }, Date.now()), null);
});

test('groundTrack: 3 final orbits, sane fixes, ends at center', () => {
  const center = Date.parse('2026-09-27T12:00:00.000Z');
  const track = groundTrack(makeTle(), center, { orbitsBack: 3, stepSec: 120 });
  assert.ok(track.length > 100, `got ${track.length} points`);
  for (const [lon, lat, h] of track) {
    assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && h > 0);
  }
  // Track spans ~3 orbits (~4.5h for this fixture): first point well before center.
  const spanH = 4; // fixture period ~91.6 min
  assert.ok(track.length >= (3 * 91.6 * 60) / 120 - 5);
  // Regression: the period must come from the TLE's mean motion (satrec.no),
  // not the 100-minute fallback. Fixture mean motion 15.72125391 rev/day →
  // 91.59 min/orbit → ~138 points at 120 s steps; the fallback would give 151.
  assert.ok(track.length <= 144, `period fell back to 100 min: ${track.length} points`);
});

test('uncertaintyBand returns nominal + early/late tracks', () => {
  const c = coerceCandidate(RAW);
  const band = uncertaintyBand(c, { orbitsBack: 1, stepSec: 300 });
  assert.ok(band.nominal.length > 0);
  assert.equal(band.early.length, band.nominal.length);
  assert.equal(band.late.length, band.nominal.length);
  // Early/late tracks differ from nominal (shifted centers).
  assert.notDeepEqual(band.early[0], band.nominal[0]);
  assert.equal(uncertaintyBand({ ...c, tle: null }), null);
});

test('overflightAlert flags a 51.6° track as land-crossing (heuristic)', () => {
  const center = Date.parse('2026-09-27T12:00:00.000Z');
  const track = groundTrack(makeTle(), center, { orbitsBack: 3, stepSec: 180 });
  const alert = overflightAlert(track);
  assert.equal(alert.points, track.length);
  assert.ok(alert.crossesLand, 'a 51.6° inclination track must cross land');
  assert.ok(alert.landPoints > 0 && alert.oceanPoints > 0);
  assert.match(alert.note, /heuristic/);
  const oceanOnly = overflightAlert([[0, -140, 400000]]);
  assert.equal(oceanOnly.crossesLand, false);
});

test('formatTiming renders modeled timing lines', () => {
  assert.equal(formatTiming(coerceCandidate(RAW)), 'T-5.0d ± 24.0h window (modeled)');
  assert.equal(formatTiming(coerceCandidate({ ...RAW, tcaDays: 0.25, windowHours: null })), 'T-6h (modeled)');
});

test('URGENCY_STYLE covers all tiers', () => {
  for (const k of ['critical', 'elevated', 'watch', 'nominal']) {
    assert.ok(URGENCY_STYLE[k].label && URGENCY_STYLE[k].color);
  }
});

test('rankCandidates sorts soonest TCA first', () => {
  const a = coerceCandidate(RAW);
  const b = coerceCandidate({ ...RAW, id: 'later', tcaUtc: '2026-10-10T00:00:00.000Z' });
  assert.deepEqual(rankCandidates([b, a]).map((c) => c.id), ['re-25544', 'later']);
});

test('createReentrySource coerces + sorts via injected fetch', async () => {
  const payload = {
    candidates: [
      { ...RAW, id: 'later', tcaUtc: '2026-10-10T00:00:00.000Z' },
      RAW,
      { ...RAW, id: 'bad', tcaDays: 'soon' },
    ],
    fetchedAt: '2026-09-27T00:00:00.000Z',
    honesty: 'test',
  };
  const fetchImpl = async () => ({ ok: true, json: async () => payload });
  const snap = await createReentrySource({ fetchImpl }).getReentries();
  assert.equal(snap.candidates.length, 2);
  assert.equal(snap.candidates[0].id, 're-25544'); // soonest first
  assert.equal(snap.honesty, 'test');
});

test('createReentrySource throws on malformed proxy response', async () => {
  const fetchImpl = async () => ({ ok: true, json: async () => ({ candidates: 42 }) });
  await assert.rejects(() => createReentrySource({ fetchImpl }).getReentries(), /Malformed/);
});
