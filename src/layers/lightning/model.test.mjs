import { test } from 'node:test';
import assert from 'node:assert/strict';
import { subsolarPoint } from '../terminator/model.js';
import {
  createSeededRng,
  angularDistanceDeg,
  isNightSide,
  decayAlpha,
  strikeFlashColor,
  isConvectivePixel,
  intensityFromWarmFraction,
  tilePixelToLonLat,
  cellCenter,
  cellIdFor,
  jitterStrike,
  sampleStrikes,
  mapAnalystRecord,
  STRIKE_TTL_MS,
  NIGHT_MARGIN_DEG,
} from './model.js';

test('createSeededRng is deterministic and yields [0,1)', () => {
  const a = createSeededRng(42);
  const b = createSeededRng(42);
  for (let i = 0; i < 50; i += 1) {
    const x = a();
    assert.equal(x, b());
    assert.ok(x >= 0 && x < 1);
  }
  const c = createSeededRng(43);
  assert.notEqual(a(), c());
});

test('angularDistanceDeg: identity and antipode', () => {
  assert.equal(angularDistanceDeg(10, 20, 10, 20), 0);
  assert.ok(Math.abs(angularDistanceDeg(0, 0, 0, 180) - 180) < 1e-9);
  assert.ok(Math.abs(angularDistanceDeg(0, 0, 0, 90) - 90) < 1e-9);
});

test('isNightSide: subsolar point is day, antipode is night', () => {
  const date = new Date('2026-09-26T12:00:00Z');
  const sub = subsolarPoint(date);
  assert.equal(isNightSide(sub.lat, sub.lon, date), false);
  const antiLon = ((sub.lon + 180 + 540) % 360) - 180;
  assert.equal(isNightSide(-sub.lat, antiLon, date), true);
  // garbage input degrades to false, never throws
  assert.equal(isNightSide(NaN, 0, date), false);
  assert.equal(isNightSide(0, 0, 'not-a-date'), false);
});

test('decayAlpha envelope: 1 at ignition, 0 at/after TTL', () => {
  assert.equal(decayAlpha(0), 1);
  assert.equal(decayAlpha(-5), 1);
  assert.equal(decayAlpha(STRIKE_TTL_MS), 0);
  assert.equal(decayAlpha(STRIKE_TTL_MS + 999), 0);
  assert.ok(Math.abs(decayAlpha(STRIKE_TTL_MS / 2) - 0.5) < 1e-9);
  assert.equal(decayAlpha(10, 0), 0);
});

test('strikeFlashColor: white-ish core, alpha follows decay, intensity shifts hue', () => {
  const low = strikeFlashColor(0, 0);
  const high = strikeFlashColor(1, 0);
  assert.equal(low.alpha, 1);
  assert.ok(low.r > high.r && low.g > high.g, 'high intensity shifts toward blue-violet halo');
  assert.ok(high.b >= low.b);
  for (const v of [low.r, low.g, low.b, high.r, high.g, high.b]) {
    assert.ok(v >= 0 && v <= 1, `channel ${v} in range`);
  }
  const aged = strikeFlashColor(1, STRIKE_TTL_MS * 2);
  assert.equal(aged.alpha, 0);
  // out-of-range intensity is clamped, not fatal
  const over = strikeFlashColor(99, 0);
  assert.ok(over.r >= 0 && over.r <= 1);
});

test('isConvectivePixel: warm palette bins only', () => {
  assert.equal(isConvectivePixel(255, 140, 0), true); // orange — high dBZ
  assert.equal(isConvectivePixel(230, 40, 120), true); // magenta — highest bin
  assert.equal(isConvectivePixel(0, 200, 80), false); // green — stratiform
  assert.equal(isConvectivePixel(80, 140, 255), false); // blue — light rain
  assert.equal(isConvectivePixel(255, 255, 255), false); // white max bin excluded by blue cap
});

test('intensityFromWarmFraction: threshold gate + saturation', () => {
  assert.equal(intensityFromWarmFraction(0), 0);
  assert.equal(intensityFromWarmFraction(0.019), 0);
  assert.equal(intensityFromWarmFraction(0.15), 1);
  assert.equal(intensityFromWarmFraction(0.9), 1);
  const mid = intensityFromWarmFraction(0.075);
  assert.ok(mid > 0.4 && mid < 0.6);
  assert.equal(intensityFromWarmFraction(NaN), 0);
});

test('tilePixelToLonLat: known corners', () => {
  const nw = tilePixelToLonLat(0, 0, 0, 0, 1);
  assert.ok(Math.abs(nw.lon - -180) < 1e-9);
  assert.ok(Math.abs(nw.lat - 85.0511) < 0.01);
  const se = tilePixelToLonLat(1, 1, 256, 256, 1);
  assert.ok(Math.abs(se.lon - 180) < 1e-9);
  assert.ok(Math.abs(se.lat - -85.0511) < 0.01);
});

test('cellCenter / cellIdFor: stable, in-bounds ids', () => {
  const c = cellCenter(2, 3, 0, 0);
  assert.ok(c.lat >= -90 && c.lat <= 90 && c.lon >= -180 && c.lon <= 180);
  assert.equal(cellIdFor(2, 3, 0, 0), 'lightning:cell:2:3:0:0');
  const c2 = cellCenter(2, 3, 0, 0);
  assert.deepEqual(c, c2);
});

test('jitterStrike: bounded, seeded, wraps longitude', () => {
  const rng = createSeededRng(7);
  const cell = { lat: 40, lon: 179.5 };
  for (let i = 0; i < 100; i += 1) {
    const s = jitterStrike(cell, rng, 4);
    assert.ok(Math.abs(s.lat - 40) <= 4);
    assert.ok(s.lon >= -180 && s.lon <= 180);
  }
  const rngA = createSeededRng(7);
  const rngB = createSeededRng(7);
  assert.deepEqual(jitterStrike(cell, rngA), jitterStrike(cell, rngB));
  // pole clamp
  const polar = jitterStrike({ lat: 89.9, lon: 0 }, createSeededRng(1), 4);
  assert.ok(polar.lat <= 90);
});

test('sampleStrikes: honest shape, weighting, filtering, count', () => {
  const rng = createSeededRng(11);
  const cells = [
    { lat: 10, lon: 20, intensity: 0.9, cellId: 'a' },
    { lat: -30, lon: 40, intensity: 0.1, cellId: 'b' },
    { lat: 0, lon: 0, intensity: 0, cellId: 'zero' }, // filtered
    { lat: NaN, lon: 0, intensity: 1, cellId: 'bad' }, // filtered
  ];
  const strikes = sampleStrikes(cells, { count: 200, rng, nowMs: 1234 });
  assert.equal(strikes.length, 200);
  for (const s of strikes) {
    assert.equal(s.modeled, true);
    assert.equal(s.sourceLabel, 'Modeled from radar');
    assert.equal(s.timeMs, 1234);
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon));
  }
  const ids = new Set(strikes.map((s) => s.id));
  assert.equal(ids.size, 200, 'unique strike ids');
  const fromA = strikes.filter((s) => s.cellId === 'a').length;
  assert.ok(fromA > 140, `weighted sampling favors intensity (a=${fromA})`);
  assert.deepEqual(sampleStrikes([], { count: 5 }), []);
  assert.deepEqual(sampleStrikes(cells, { count: 0 }), []);
});

test('mapAnalystRecord: minimal honest record', () => {
  const rec = mapAnalystRecord(
    { id: 'x', lat: 1, lon: 2, timeMs: 5, intensity: 0.7 },
    0,
  );
  assert.equal(rec.kind, 'lightning');
  assert.equal(rec.modeled, true);
  assert.equal(rec.lat, 1);
  assert.equal(mapAnalystRecord(null), null);
});
