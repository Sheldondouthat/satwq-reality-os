import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coerceStation,
  stationPulse,
  detectForbush,
  globalMood,
  rankStations,
  formatMAD,
  pulsePhase,
  isLive,
  COSMIC_HONESTY,
  FORBUSH_THRESHOLD_MAD,
  FORBUSH_MIN_STATIONS,
} from './model.js';

const st = (over = {}) => ({
  code: 'OULU',
  name: 'Oulu',
  lat: 65.05,
  lon: 25.47,
  latest: { t: '2026-09-27T12:00:00Z', value: -1.2 },
  median: -0.04,
  deviation: -1.16,
  deviationMAD: -3.1,
  samples: 1440,
  status: 'ok',
  ...over,
});

test('coerceStation maps the W5 MAD payload and rejects junk', () => {
  const s = coerceStation(st());
  assert.equal(s.code, 'OULU');
  assert.equal(s.deviationMAD, -3.1);
  assert.equal(s.deviation, -1.16);
  assert.equal(s.status, 'ok');
  assert.equal(coerceStation(null), null);
  assert.equal(coerceStation({ ...st(), lat: 95 }), null);
  assert.equal(coerceStation({ ...st(), lon: 'nope' }), null);
});

test('isLive requires a finite deviationMAD (flat series has null MAD)', () => {
  assert.equal(isLive(coerceStation(st())), true);
  assert.equal(isLive(coerceStation(st({ status: 'nodata' }))), false);
  // W5 sets deviationMAD=null when MAD≈0 (flat series) — not a drop.
  assert.equal(isLive(coerceStation(st({ deviationMAD: null }))), false);
});

test('stationPulse colors and sizes by MAD units', () => {
  assert.equal(stationPulse(-5.5).color, '#ff3b3b');
  assert.equal(stationPulse(-2).color, '#ff9f5a');
  assert.equal(stationPulse(0.5).color, '#7ee2a8');
  assert.equal(stationPulse(4).color, '#59c2ff');
  assert.ok(stationPulse(-8).size > stationPulse(-1).size);
  assert.ok(stationPulse(null).size >= 6);
});

test('pulsePhase oscillates 0..1 on numeric ms and never NaNs on junk', () => {
  // Regression: the Cesium CallbackProperty hands us a JulianDate OBJECT.
  // Feeding that object into Math.sin produced NaN pixel sizes. pulsePhase
  // takes numeric ms (callers convert via JulianDate.toDate(t).getTime()).
  assert.ok(pulsePhase(0) >= 0 && pulsePhase(0) <= 1);
  assert.ok(pulsePhase(450 * Math.PI) >= 0 && pulsePhase(450 * Math.PI) <= 1);
  assert.notEqual(pulsePhase(0), pulsePhase(225), 'it actually oscillates');
  assert.equal(pulsePhase(NaN), 0);
});

test('formatMAD renders sigma labels', () => {
  assert.equal(formatMAD(-4.2), '-4.2σ');
  assert.equal(formatMAD(1.0), '+1.0σ');
  assert.equal(formatMAD(null), '—');
});

test('detectForbush alerts on ≤ −3 MAD at ≥3 stations (MAD units, not %)', () => {
  assert.equal(FORBUSH_THRESHOLD_MAD, -3);
  assert.equal(FORBUSH_MIN_STATIONS, 3);
  const stations = ['A', 'B', 'C'].map((code, i) =>
    coerceStation(st({ code, deviationMAD: -4 - i })),
  );
  const r = detectForbush(stations);
  assert.equal(r.level, 'alert');
  assert.equal(r.drops.length, 3);
  assert.equal(r.maxDropMAD, -6);
  // two drops only → watch
  assert.equal(detectForbush(stations.slice(0, 2)).level, 'watch');
  // mild drops → quiet
  const quiet = stations.map((s) => coerceStation({ ...s, deviationMAD: -0.5 }));
  assert.equal(detectForbush(quiet).level, 'quiet');
  // null-MAD (flat) stations do not contribute
  const flat = coerceStation(st({ code: 'FLAT', deviationMAD: null }));
  assert.equal(isLive(flat), false);
  assert.equal(detectForbush([...stations, flat]).level, 'alert');
});

test('globalMood reflects median MAD with sigma labels', () => {
  const suppressed = ['A', 'B', 'C'].map((code) =>
    coerceStation(st({ code, deviationMAD: -4 })),
  );
  const m = globalMood(suppressed);
  assert.equal(m.label, 'SUPPRESSED');
  assert.equal(m.color, '#ff3b3b');
  const quiet = ['A', 'B', 'C'].map((code) =>
    coerceStation(st({ code, deviationMAD: 0.2 })),
  );
  assert.equal(globalMood(quiet).label, 'QUIET');
  assert.equal(globalMood([]).label, 'NO DATA');
});

test('rankStations sorts by |deviationMAD| and COSMIC_HONESTY discloses the model', () => {
  const stations = ['A', 'B'].map((code, i) =>
    coerceStation(st({ code, deviationMAD: i === 0 ? -1 : 5 })),
  );
  assert.equal(rankStations(stations)[0].code, 'B');
  assert.match(COSMIC_HONESTY, /deviationMAD/);
  assert.match(COSMIC_HONESTY, /not a Forbush identification|not absolute flux/);
});
