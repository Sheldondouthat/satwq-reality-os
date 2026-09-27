import assert from 'node:assert/strict';
import test from 'node:test';
import { tidesProxy, _tidesInternals } from './tides.js';

const { parseWaterLevel, parsePredictions, coopsTimeToISO, buildSnapshot, parseQuery, clearCaches } = _tidesInternals;

// Fixtures are REAL payloads captured live from CO-OPS on 2026-09-27
// (api.tidesandcurrents.noaa.gov, HTTP 200 JSON, station 8638610 Sewells Point).

const WATER_LEVEL_FIXTURE = {
  metadata: { id: '8638610', name: 'Sewells Point', lat: '36.9428', lon: '-76.3286' },
  data: [
    { t: '2026-09-24 21:12', v: '4.501', s: '0.069', f: '1,0,0,0', q: 'p' },
    { t: '2026-09-24 21:18', v: '4.564', s: '0.066', f: '1,0,0,0', q: 'p' },
    { t: '2026-09-24 21:24', v: 'bad', s: '0.056', f: '1,0,0,0', q: 'p' },
  ],
};

const PREDICTIONS_FIXTURE = {
  predictions: [
    { t: '2026-09-27 01:41', v: '2.98', type: 'H' },
    { t: '2026-09-27 07:47', v: '0.271', type: 'L' },
  ],
};

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
  };
  return res;
}

function fakeReq(url, method = 'GET') {
  return { method, url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('coopsTimeToISO parses GMT wall-clock as UTC', () => {
  assert.equal(coopsTimeToISO('2026-09-27 01:41'), '2026-09-27T01:41:00.000Z');
  assert.equal(coopsTimeToISO('2026-09-24 21:12:30'), '2026-09-24T21:12:30.000Z');
  assert.equal(coopsTimeToISO('nope'), null);
  assert.equal(coopsTimeToISO(null), null);
});

test('parseWaterLevel trims rows, drops unparseable values', () => {
  const rows = parseWaterLevel(WATER_LEVEL_FIXTURE);
  assert.equal(rows.length, 2); // the 'bad' v row is dropped
  assert.equal(rows[0].time, '2026-09-24T21:12:00.000Z');
  assert.equal(rows[0].feet, 4.501);
  assert.equal(rows[0].quality, 'p');
});

test('parsePredictions trims hilo rows', () => {
  const rows = parsePredictions(PREDICTIONS_FIXTURE);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].type, 'H');
  assert.equal(rows[0].feet, 2.98);
  assert.equal(rows[1].type, 'L');
  assert.equal(rows[1].time, '2026-09-27T07:47:00.000Z');
});

test('parseQuery defaults, normalizes kind, rejects non-numeric stations', () => {
  assert.deepEqual(parseQuery(fakeReq('/api/tides')), { station: '8638610', kind: 'water_level' });
  assert.deepEqual(parseQuery(fakeReq('/api/tides?station=8575484&kind=predictions')), { station: '8575484', kind: 'predictions' });
  assert.deepEqual(parseQuery(fakeReq('/api/tides?kind=bogus')), { station: '8638610', kind: 'water_level' });
  assert.throws(() => parseQuery(fakeReq('/api/tides?station=8638610%27%3B%20DROP')), { message: /tides_bad_station/ });
  assert.throws(() => parseQuery(fakeReq('/api/tides?station=../x')), { message: /tides_bad_station/ });
});

test('buildSnapshot merges both products and reports sources honestly', () => {
  const snap = buildSnapshot([
    { key: 'water_level', ok: true, latencyMs: 10, metadata: WATER_LEVEL_FIXTURE.metadata, readings: parseWaterLevel(WATER_LEVEL_FIXTURE) },
    { key: 'predictions', ok: false, latencyMs: 10, error: 'tides_upstream_503', readings: [] },
  ], '8638610');
  assert.equal(snap.station.name, 'Sewells Point');
  assert.equal(snap.station.lat, 36.9428);
  assert.equal(snap.sources.water_level.ok, true);
  assert.equal(snap.sources.predictions.ok, false);
  assert.equal(snap.sources.predictions.error, 'tides_upstream_503');
  assert.equal(snap.waterLevel.length, 2);
  assert.equal(snap.predictions, null); // failed product stays null, not empty-array lie
  assert.equal(snap.current.feet, 4.564);
  assert.equal(snap.units, 'feet MLLW');
});

test('provider mounts /api/tides and rejects non-GET', async () => {
  const calls = mount(tidesProxy());
  assert.ok(calls.some((c) => c.route === '/api/tides'));
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/tides', 'POST'), res);
  assert.equal(res.statusCode, 405);
});

test('handler returns 400 for a non-numeric station', async () => {
  const { handler } = mount(tidesProxy())[0];
  const res = fakeRes();
  await handler(fakeReq('/api/tides?station=abc'), res);
  assert.equal(res.statusCode, 400);
  assert.equal(JSON.parse(res.body).error, 'tides_bad_station');
});

test('handler returns 200 with both products on live-shaped JSON', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('product=predictions') ? PREDICTIONS_FIXTURE : WATER_LEVEL_FIXTURE;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    clearCaches();
    const { handler } = mount(tidesProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/tides?station=8638610&kind=both'), res);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.waterLevel.length, 2);
    assert.equal(parsed.predictions.length, 2);
    assert.equal(parsed.sources.water_level.ok, true);
    assert.equal(parsed.sources.predictions.ok, true);
    assert.equal(parsed.station.name, 'Sewells Point');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler returns 502 JSON when both products fail', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    clearCaches();
    const { handler } = mount(tidesProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/tides?kind=both'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'tides_unavailable');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler degrades honestly when only one product fails', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('product=predictions')) return new Response('down', { status: 503 });
    return new Response(JSON.stringify(WATER_LEVEL_FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    clearCaches();
    const { handler } = mount(tidesProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/tides?kind=both'), res);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.ok(parsed.waterLevel.length > 0);
    assert.equal(parsed.predictions, null);
    assert.equal(parsed.sources.predictions.ok, false);
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
