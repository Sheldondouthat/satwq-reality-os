import assert from 'node:assert/strict';
import test from 'node:test';
import { radiationProxy, _radiationInternals } from './radiation.js';

const { stationArray, parseLenientJson, trimCpmStation, trimRadonStation, buildSnapshot, clearCaches } = _radiationInternals;

// Fixtures are SYNTHETIC, labeled as such: gmcmap.com timed out from the
// build VM on 2026-09-27 (curl 000 both endpoints; VM-throttled, needs a
// Worker-side probe). Shapes follow the catalog note ("JSON-ish, ~100 live
// stations, CPM") plus the site's documented field conventions.

// Bare-array shape, site-style key spellings.
const CPM_ARRAY_FIXTURE = [
  { Id: '101', Name: 'Test Station A', lat: '37.7749', lng: '-122.4194', CPM: '42', uSv: '0.12', time: '2026-09-27 20:00:00', alert: '0' },
  { Id: '102', Name: 'Test Station B', lat: '40.7128', lng: '-74.0060', CPM: '310', uSv: '0.85', time: '2026-09-27 19:58:00', alert: '1' },
  { Id: '103', Name: 'No Coords', CPM: '20' }, // filtered: no lat/lon
];

// Wrapped shape with alternate spellings.
const CPM_WRAPPED_FIXTURE = {
  stations: [
    { id: '201', name: 'Wrapped Station', latitude: 51.5, longitude: -0.12, cpm: 55 },
  ],
};

const RADON_FIXTURE = [
  { Id: 'r1', Name: 'Radon A', lat: '39.0', lng: '-105.5', pCi: '1.4', bq: '52', time: '2026-09-27 18:00:00' },
];

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

test('stationArray accepts bare arrays and common wrappers', () => {
  assert.equal(stationArray(CPM_ARRAY_FIXTURE).length, 3);
  assert.equal(stationArray(CPM_WRAPPED_FIXTURE).length, 1);
  assert.equal(stationArray({ markers: [{ x: 1 }] }).length, 1);
  assert.deepEqual(stationArray({}), []);
  assert.deepEqual(stationArray(null), []);
  assert.deepEqual(stationArray('junk'), []);
});

test('parseLenientJson parses clean JSON and strips wrapper noise', () => {
  assert.deepEqual(parseLenientJson('{"a":1}'), { a: 1 });
  assert.deepEqual(parseLenientJson('while(1);\n[{"a":1}]'), [{ a: 1 }]);
  assert.deepEqual(parseLenientJson('  \n  [1,2]  '), [1, 2]);
  assert.throws(() => parseLenientJson('<html>down for maintenance</html>'), { message: /radiation_unparseable_body/ });
});

test('trimCpmStation maps site-style keys, filters coordless rows', () => {
  const rows = CPM_ARRAY_FIXTURE.map(trimCpmStation).filter(Boolean);
  assert.equal(rows.length, 2);
  const a = rows[0];
  assert.equal(a.id, '101');
  assert.equal(a.lat, 37.7749);
  assert.equal(a.lon, -122.4194);
  assert.equal(a.cpm, 42);
  assert.equal(a.usvPerHour, 0.12);
  assert.equal(a.alert, false);
  assert.equal(rows[1].alert, true);
  assert.equal(rows[1].cpm, 310);
});

test('trimCpmStation tolerates lowercase spellings and wrapped shape', () => {
  const s = trimCpmStation(CPM_WRAPPED_FIXTURE.stations[0]);
  assert.equal(s.id, '201');
  assert.equal(s.lat, 51.5);
  assert.equal(s.lon, -0.12);
  assert.equal(s.cpm, 55);
});

test('trimRadonStation maps pCi/L and Bq/m³', () => {
  const s = trimRadonStation(RADON_FIXTURE[0]);
  assert.equal(s.id, 'r1');
  assert.equal(s.pCiPerL, 1.4);
  assert.equal(s.bqPerM3, 52);
  assert.equal(s.lat, 39);
  assert.equal(s.lon, -105.5);
});

test('buildSnapshot reports per-source honesty', () => {
  const snap = buildSnapshot([
    { key: 'cpm', ok: true, count: 2, latencyMs: 5, stations: CPM_ARRAY_FIXTURE.slice(0, 2).map(trimCpmStation).filter(Boolean) },
    { key: 'radon', ok: false, count: 0, latencyMs: 5, error: 'radiation_upstream_502', stations: [] },
  ]);
  assert.equal(snap.count, 2);
  assert.equal(snap.radonCount, 0);
  assert.equal(snap.sources.cpm.ok, true);
  assert.equal(snap.sources.radon.ok, false);
  assert.ok(snap.attribution.includes('gmcmap.com'));
});

test('provider mounts /api/radiation and rejects non-GET', async () => {
  const calls = mount(radiationProxy());
  assert.ok(calls.some((c) => c.route === '/api/radiation'));
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/radiation', 'POST'), res);
  assert.equal(res.statusCode, 405);
});

test('handler returns 200 on live-shaped fixture bodies', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('ajaxmr.php') ? RADON_FIXTURE : CPM_ARRAY_FIXTURE;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    clearCaches();
    const { handler } = mount(radiationProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/radiation'), res);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.count, 2);
    assert.equal(parsed.radonCount, 1);
    assert.equal(parsed.stations[0].cpm, 42);
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler returns 502 JSON when both sources are down', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    clearCaches();
    const { handler } = mount(radiationProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/radiation'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'radiation_unavailable');
    assert.ok(res.headers['Cache-Control'].includes('no-store'));
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
