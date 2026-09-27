/**
 * Eyes-on countdown tests — node:test, REAL assertions.
 *
 * SGP4 math runs against a static Landsat-9-style TLE: TLE parsing,
 * imaging-candidate matching, countdown formatting, and a full
 * findEarliestPass run over 48 h with a fixed observer and epoch
 * (deterministic — no network, no clock).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { twoline2satrec, propagate } from 'satellite.js';
import {
  parseTleText,
  isImagingCandidate,
  formatCountdown,
  findEarliestPass,
  IMAGING_PATTERNS,
} from './index.js';

// Static sun-sync TLE (Landsat-9-like). Epoch 2026 day 270.5 = Sep 27 12:00 UTC.
const TLE_TEXT = `LANDSAT 9
1 49260U 21088A   26270.50000000  .00001000  00000-0  12345-3 0  9990
2 49260  98.2100 150.0000 0001200  90.0000 270.0000 14.82300000    10
ISS (ZARYA)
1 25544U 98067A   26270.50000000  .00016717  00000-0  10270-3 0  9991
2 25544  51.6400 208.9163 0006703  69.9862  25.2906 15.49560532    10`;

const FROM_MS = Date.UTC(2026, 8, 27, 12, 0, 0); // == TLE epoch

describe('parseTleText', () => {
  it('parses 3-line sets and skips malformed blocks', () => {
    const sets = parseTleText(TLE_TEXT);
    assert.equal(sets.length, 2);
    assert.equal(sets[0].name, 'LANDSAT 9');
    assert.ok(sets[0].line1.startsWith('1 '));
    assert.ok(sets[0].line2.startsWith('2 '));
    assert.equal(parseTleText('garbage\n1 12345U\nnope').length, 0);
    assert.deepEqual(parseTleText(null), []);
  });

  it('yields a parseable satrec with LEO-like radius at epoch', () => {
    const [set] = parseTleText(TLE_TEXT);
    const satrec = twoline2satrec(set.line1, set.line2);
    const pv = propagate(satrec, new Date(FROM_MS));
    const r = Math.hypot(pv.position.x, pv.position.y, pv.position.z);
    // Sun-sync ~705 km altitude → radius ≈ 7070 km. A column-misaligned
    // parse would not land in this band.
    assert.ok(r > 6900 && r < 7300, `radius=${r} km`);
  });
});

describe('isImagingCandidate', () => {
  it('matches known imaging missions', () => {
    assert.equal(isImagingCandidate('LANDSAT 9'), true);
    assert.equal(isImagingCandidate('SENTINEL-2A'), true);
    assert.equal(isImagingCandidate('WORLDVIEW-3'), true);
    assert.equal(isImagingCandidate('TERRASAR-X'), true);
  });

  it('rejects non-imaging spacecraft', () => {
    assert.equal(isImagingCandidate('ISS (ZARYA)'), false);
    assert.equal(isImagingCandidate('STARLINK-1007'), false);
    assert.equal(isImagingCandidate('GPS BIII-04'), false);
    assert.equal(isImagingCandidate(null), false);
  });

  it('has a non-trivial pattern list', () => {
    assert.ok(IMAGING_PATTERNS.length >= 15, `patterns=${IMAGING_PATTERNS.length}`);
  });
});

describe('formatCountdown', () => {
  it('formats HH:MM:SS', () => {
    assert.equal(formatCountdown(4 * 3600_000 + 12 * 60_000 + 33_000), '04:12:33');
    assert.equal(formatCountdown(0), '00:00:00');
    assert.equal(formatCountdown(-5000), '00:00:00');
  });
});

describe('findEarliestPass (real SGP4)', () => {
  it('finds a ≥25° Landsat 9 pass over Virginia within 48 h', async () => {
    const [landsat] = parseTleText(TLE_TEXT);
    const candidates = [
      { name: landsat.name, satrec: twoline2satrec(landsat.line1, landsat.line2) },
    ];
    // Pembroke, VA area.
    const best = await findEarliestPass(candidates, 37.32, -80.83, FROM_MS);
    assert.ok(best, 'expected a pass');
    assert.equal(best.name, 'LANDSAT 9');
    assert.ok(best.pass.riseMs > FROM_MS, 'rise is in the future');
    assert.ok(best.pass.riseMs < FROM_MS + 48 * 3600_000, 'rise within horizon');
    assert.ok(best.pass.maxElevDeg >= 25, `maxElev=${best.pass.maxElevDeg}`);
    assert.ok(best.pass.setMs > best.pass.riseMs, 'set after rise');
  });

  it('returns null when no candidate can pass', async () => {
    const best = await findEarliestPass([], 37.32, -80.83, FROM_MS);
    assert.equal(best, null);
  });
});
