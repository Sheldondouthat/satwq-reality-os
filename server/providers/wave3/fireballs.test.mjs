/**
 * fireballs provider tests — REAL assertions on CNEOS row normalization.
 * Fixture rows mirror the live API shape verified 2026-09-27:
 * fields ["date","energy","impact-e","lat","lat-dir","lon","lon-dir","alt","vel"].
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fireballsProxy,
  normalizeFireballRow,
  parseFireballDate,
} from './fireballs.js';

const FIELDS = ['date', 'energy', 'impact-e', 'lat', 'lat-dir', 'lon', 'lon-dir', 'alt', 'vel'];

// Live row from 2026-09-11: 0.67 kt over Canada (verified 2026-09-27).
// NOTE: energy=24.6 is RADIATED energy in 10^10 J — the kiloton figure is
// impact-e=0.67 (CNEOS API doc v1.2). Do not confuse the two.
const LIVE_ROW = ['2026-09-11 01:12:11', '24.6', '0.67', '54.4', 'N', '100.1', 'W', '38.0', null];
// Row with null velocity (common in the archive).
const NULL_VEL_ROW = ['2026-09-15 11:26:13', '2.2', '0.079', '37.6', 'S', '161.6', 'W', '37.0', null];

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}
function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null, headers: {},
    writeHead(s, h) { res.statusCode = s; res.headers = h; },
    end(b) { chunks.push(b); res.body = chunks.join(''); },
  };
  return res;
}

test('parseFireballDate parses CNEOS timestamps as UTC', () => {
  assert.equal(parseFireballDate('2026-09-11 01:12:11'), '2026-09-11T01:12:11.000Z');
  assert.equal(parseFireballDate('not a date'), null);
  assert.equal(parseFireballDate(null), null);
});

test('normalizeFireballRow converts a live CNEOS row exactly', () => {
  const ev = normalizeFireballRow(LIVE_ROW, FIELDS);
  assert.equal(ev.dateUtc, '2026-09-11T01:12:11.000Z');
  assert.equal(ev.energyKt, 0.67); // kilotons come from impact-e, NOT energy
  assert.equal(ev.radiatedE10J, 24.6); // energy = 10^10 J, kept honestly labeled
  assert.equal(ev.impactEnergyKt, 0.67);
  assert.equal(ev.lat, 54.4);
  assert.equal(ev.lon, -100.1); // W → negative
  assert.equal(ev.altKm, 38.0);
  assert.equal(ev.velKms, null);
});

test('normalizeFireballRow handles southern hemisphere + null vel', () => {
  const ev = normalizeFireballRow(NULL_VEL_ROW, FIELDS);
  assert.equal(ev.lat, -37.6); // S → negative
  assert.equal(ev.lon, -161.6);
  assert.equal(ev.energyKt, 0.079);
  assert.equal(ev.radiatedE10J, 2.2);
});

test('normalizeFireballRow rejects bad rows', () => {
  assert.equal(normalizeFireballRow(['2026-09-11 01:12:11', '2.2', 'x', '54.4', 'N', '100.1', 'W', '38', null], FIELDS), null);
  assert.equal(normalizeFireballRow(['2026-09-11 01:12:11', '2.2', '0.1', '999', 'N', '100.1', 'W', '38', null], FIELDS), null);
  assert.equal(normalizeFireballRow('not-an-array', FIELDS), null);
});

test('fireballsProxy mounts /api/fireballs on both server shapes', () => {
  const provider = fireballsProxy();
  assert.equal(provider.name, 'fireballs');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/fireballs', '/api/fireballs']);
});

test('fireballsProxy rejects non-GET with 405 without touching upstream', async () => {
  const provider = fireballsProxy();
  const calls = [];
  provider.configureServer({ middlewares: { use: (r, h) => calls.push({ r, h }) } });
  const res = fakeRes();
  await calls[0].h(fakeReq('/api/fireballs', 'POST'), res);
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /method_not_allowed/);
});

test('fireballsProxy serves normalized events end-to-end (fetch-path regression)', async () => {
  // 2026-09-27 near-miss: fetchJson destructured {tooLarge, json} from
  // readResponseJsonCapped, which returns parsed JSON directly — every real
  // request 502'd with 'fireball_upstream_empty' while the suite stayed
  // green (no test touched the fetch path). This drives the real handler
  // with a stubbed global fetch and a CNEOS-shaped payload.
  const payload = { fields: FIELDS, data: [LIVE_ROW, NULL_VEL_ROW], count: 2 };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    const provider = fireballsProxy();
    const calls = [];
    provider.configureServer({ middlewares: { use: (r, h) => calls.push({ r, h }) } });
    const res = fakeRes();
    await calls[0].h(fakeReq('/api/fireballs?days=30'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.count, 2);
    assert.equal(body.events.length, 2);
    const big = body.events.find((e) => e.energyKt === 0.67);
    assert.ok(big, 'the 0.67 kt event is present');
    assert.equal(big.radiatedE10J, 24.6);
    assert.equal(big.lat, 54.4);
    assert.equal(big.lon, -100.1); // W → negative
    assert.equal(big.recent, true);
    assert.ok(body.honesty);
    assert.equal(body.upstream, 'https://ssd-api.jpl.nasa.gov/fireball.api');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('units are anchored: Chelyabinsk energy=37500 (10^10 J) → radiatedE10J, impact-e=441 → energyKt', () => {
  // CNEOS API doc v1.2: `energy` is radiated energy in joules × 10^10,
  // `impact-e` is kilotons. A swap here would mislabel every event by ~85×.
  const row = ['2013-02-15 03:20:26', '37500', '441', '55.1', 'N', '61.4', 'E', '23.3', null];
  const ev = normalizeFireballRow(row, FIELDS);
  assert.equal(ev.energyKt, 441);
  assert.equal(ev.radiatedE10J, 37500);
  assert.notEqual(ev.energyKt, 37500, 'radiated energy must never be labeled kilotons');
});
