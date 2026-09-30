import assert from 'node:assert/strict';
import test from 'node:test';
import { phoneSensorsProxy, _phoneSensorsInternals } from './phoneSensors.js';

const { buildPayload, FRESH_MS } = _phoneSensorsInternals;
const T0 = Date.parse('2026-09-30T10:00:00Z');

const freshState = {
  pressure_hpa: 963.29,
  pressure_ts_ms: T0 - 60_000,
  poll_ts_ms: T0 - 60_000,
  // GPS present in state on purpose — the provider must still strip it.
  lat: 37.267, lon: -80.726, accuracy_m: 20, gps_ts_ms: T0 - 60_000,
};

test('fresh reading -> one pressure-only station, not stale', () => {
  const p = buildPayload(freshState, { now: () => T0 });
  assert.equal(p.schemaVersion, 1);
  assert.equal(p.count, 1);
  assert.equal(p.unavailable, false);
  assert.equal(p.stale, false);
  const s = p.stations[0];
  assert.equal(s.pressureHpa, 963.29);
  assert.equal(s.lat, null);
  assert.equal(s.lon, null);
  assert.equal(s.source, 's21-barometer');
});

test('GPS coordinates are NEVER served even when the state file has them', () => {
  const p = buildPayload(freshState, { now: () => T0 });
  const raw = JSON.stringify(p);
  assert.ok(!raw.includes('37.267'), 'lat leaked into payload');
  assert.ok(!raw.includes('-80.726'), 'lon leaked into payload');
});

test('reading older than 5 min -> stale:true, still served', () => {
  const p = buildPayload(
    { ...freshState, pressure_ts_ms: T0 - (FRESH_MS + 1000) },
    { now: () => T0 },
  );
  assert.equal(p.stale, true);
  assert.equal(p.unavailable, false);
  assert.equal(p.count, 1);
});

test('no state -> unavailable:true, zero stations, no fake rows', () => {
  const p = buildPayload(null, { now: () => T0 });
  assert.equal(p.unavailable, true);
  assert.equal(p.count, 0);
  assert.deepEqual(p.stations, []);
});

test('null pressure -> unavailable, never 0', () => {
  const p = buildPayload({ pressure_hpa: null, pressure_ts_ms: T0 }, { now: () => T0 });
  assert.equal(p.unavailable, true);
});

test('handler serves JSON on GET, 405 otherwise', async () => {
  const proxy = phoneSensorsProxy({ readState: async () => freshState, now: () => T0 });
  let mw;
  proxy.configureServer({ middlewares: { use: (route, fn) => { mw = { route, fn }; } } });
  assert.equal(mw.route, '/api/phone-sensors');

  const calls = [];
  const mkRes = () => ({
    writeHead: (s, h) => calls.push(['head', s, h]),
    end: (b) => calls.push(['end', JSON.parse(b)]),
  });
  await mw.fn({ method: 'GET', url: '/api/phone-sensors' }, mkRes());
  assert.equal(calls[0][1], 200);
  assert.equal(calls[1][1].count, 1);
  assert.equal(calls[1][1].stations[0].lat, null);

  const calls2 = [];
  await mw.fn({ method: 'POST', url: '/api/phone-sensors' }, {
    writeHead: (s) => calls2.push(s),
    end: () => {},
  });
  assert.equal(calls2[0], 405);
});
