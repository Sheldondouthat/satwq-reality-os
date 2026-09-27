import assert from 'node:assert/strict';
import test from 'node:test';
import { twoline2satrec } from 'satellite.js';
import {
  parseTleText,
  subSatellitePoint,
  currentlyVisible,
  prefilterCandidates,
  tonightsVisiblePasses,
  passArcPoints,
  observerSolarElevation,
  isSatelliteSunlit,
  lookAnglesAt,
} from './oracle.js';
import { findNextSatellitePass } from '../../../data/satellitePass.js';

// Real ISS TLE, epoch 2026-09-26 ~20:25 UTC (captured live from CelesTrak
// stations group 2026-09-27; embedded so tests need no network).
const ISS_NAME = 'ISS (ZARYA)';
const ISS_L1 = '1 25544U 98067A   26269.85154941  .00007609  00000+0  14781-3 0  9997';
const ISS_L2 = '2 25544  51.6312 156.9417 0007058 191.1476 168.9357 15.48656208587512';
const EPOCH_MS = Date.UTC(2026, 8, 26, 20, 25, 39); // ≈ epoch 26269.8515

const TLE_3LINE = `${ISS_NAME}\n${ISS_L1}\n${ISS_L2}\n`;
const issSat = { name: ISS_NAME, satrec: twoline2satrec(ISS_L1, ISS_L2) };

test('parseTleText parses 3-line sets; junk lines never yield partial sets', () => {
  // NOTE (root-cause log 2026-09-27): an earlier version of this test expected
  // `BAD\n<L1>\n<L2>` to be skipped, but the parser is positional 3-line
  // chunking — any non-TLE line in name position becomes the set name, and
  // there is no format-based way to distinguish "BAD" from a legitimate short
  // satellite name (CelesTrak names are free-form; even a strict NAME→L1→L2
  // state machine parses it). The test now asserts the real contract instead.
  const sats = parseTleText(`${TLE_3LINE}JUNK\n`);
  assert.equal(sats.length, 1);
  assert.equal(sats[0].name, ISS_NAME);
  // A name line with no following TLE lines yields nothing.
  assert.deepEqual(parseTleText('ORPHAN NAME\n'), []);
  // A nameless line1/line2 pair cannot form a chunk (line1 must start '1 ').
  assert.deepEqual(parseTleText(`${ISS_L1}\n${ISS_L2}\n`), []);
  assert.deepEqual(parseTleText(''), []);
  assert.deepEqual(parseTleText(null), []);
  assert.ok(sats[0].satrec);
  assert.deepEqual(parseTleText(''), []);
  assert.deepEqual(parseTleText(null), []);
});

test('subSatellitePoint: ISS is ~420 km up, within orbital inclination', () => {
  const sub = subSatellitePoint(issSat.satrec, EPOCH_MS);
  assert.ok(sub);
  assert.ok(sub.altKm > 380 && sub.altKm < 470, `alt ${sub.altKm}`);
  assert.ok(Math.abs(sub.latDeg) <= 52, `lat ${sub.latDeg}`);
  assert.ok(Math.abs(sub.lonDeg) <= 180);
});

test('subSatellitePoint returns null for a dead record', () => {
  assert.equal(subSatellitePoint({ bogus: true }, EPOCH_MS), null);
});

test('currentlyVisible: observer directly under ISS sees it near zenith', () => {
  const sub = subSatellitePoint(issSat.satrec, EPOCH_MS);
  const list = currentlyVisible([issSat], sub.latDeg, sub.lonDeg, EPOCH_MS, { minElevDeg: 0 });
  assert.equal(list.length, 1);
  assert.equal(list[0].name, ISS_NAME);
  assert.ok(list[0].elevDeg > 85, `elev ${list[0].elevDeg}`);
  // sunlit flag must agree with the direct shadow test
  const look = lookAnglesAt(issSat.satrec, EPOCH_MS, sub.latDeg, sub.lonDeg);
  assert.equal(list[0].sunlit, isSatelliteSunlit(look.satECI, EPOCH_MS));
  assert.ok(Number.isFinite(list[0].sunElevDeg));
});

test('currentlyVisible: observer at antipode sees nothing', () => {
  const sub = subSatellitePoint(issSat.satrec, EPOCH_MS);
  const list = currentlyVisible([issSat], -sub.latDeg, sub.lonDeg + 180, EPOCH_MS, { minElevDeg: 0 });
  assert.deepEqual(list, []);
});

test('prefilterCandidates keeps near tracks, drops far ones', () => {
  const sub = subSatellitePoint(issSat.satrec, EPOCH_MS);
  const near = prefilterCandidates([issSat], sub.latDeg, sub.lonDeg, EPOCH_MS, { hours: 1 });
  assert.equal(near.length, 1);
  const far = prefilterCandidates([issSat], -sub.latDeg, ((sub.lonDeg + 180 + 540) % 360) - 180, EPOCH_MS, {
    hours: 0.2,
    samples: 6,
    maxGroundDeg: 5,
  });
  assert.equal(far.length, 0);
});

test('findNextSatellitePass returns a well-formed ISS pass', () => {
  const pass = findNextSatellitePass({
    satrec: issSat.satrec,
    latDeg: 37.1,
    lonDeg: -80.4,
    fromMs: EPOCH_MS,
    minElevDeg: 10,
    horizonHours: 48,
    requireVisible: false,
  });
  assert.ok(pass, 'expected an ISS pass within 48h over Virginia');
  assert.ok(pass.riseMs < pass.maxElevMs && pass.maxElevMs < pass.setMs);
  assert.ok(pass.maxElevDeg >= 10);
  assert.ok(pass.riseAzDeg >= 0 && pass.riseAzDeg < 360);
});

test('tonightsVisiblePasses applies the twilight filter exactly', () => {
  const lat = 37.1;
  const lon = -80.4;
  const passes = tonightsVisiblePasses([issSat], lat, lon, EPOCH_MS, { horizonHours: 48 });
  assert.ok(Array.isArray(passes));
  for (const p of passes) {
    assert.equal(p.name, ISS_NAME);
    assert.ok(p.sunElevAtPeakDeg >= -18 && p.sunElevAtPeakDeg <= -6,
      `sun ${p.sunElevAtPeakDeg} outside twilight window`);
    assert.ok(p.maxElevDeg >= 10);
    // filter must agree with direct solar-elevation evaluation at the same peak
    const direct = observerSolarElevation(lat, lon, p.peakMs);
    assert.ok(Math.abs(direct - p.sunElevAtPeakDeg) < 1e-9);
  }
  // cross-check: every unfiltered pass with a twilight peak must appear
  const raw = findNextSatellitePass({
    satrec: issSat.satrec, latDeg: lat, lonDeg: lon, fromMs: EPOCH_MS,
    minElevDeg: 10, horizonHours: 48, requireVisible: false,
  });
  if (raw) {
    const sunAtPeak = observerSolarElevation(lat, lon, raw.maxElevMs);
    const inTwilight = sunAtPeak >= -18 && sunAtPeak <= -6;
    const listed = passes.some((p) => Math.abs(p.peakMs - raw.maxElevMs) < 1);
    assert.equal(listed, inTwilight, `sun at peak ${sunAtPeak}`);
  }
});

test('passArcPoints samples ascending times with finite coords', () => {
  const rise = EPOCH_MS;
  const set = EPOCH_MS + 6 * 60_000;
  const pts = passArcPoints(issSat.satrec, rise, set, 60_000);
  assert.ok(pts.length >= 6);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i].t > pts[i - 1].t);
  for (const p of pts) {
    assert.ok(Number.isFinite(p.latDeg) && Number.isFinite(p.lonDeg) && Number.isFinite(p.altKm));
  }
  assert.equal(pts[0].t, rise);
  assert.equal(pts[pts.length - 1].t, set);
});
