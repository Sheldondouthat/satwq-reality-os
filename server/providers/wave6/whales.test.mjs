import assert from 'node:assert/strict';
import test from 'node:test';
import { whalesProxy, _whalesInternals } from './whales.js';

const { detectionArray, normalizeSpecies, trimDetection, trimPlatform, buildSnapshot, clearCaches } = _whalesInternals;

// Fixtures are SYNTHETIC, labeled as such: robots4whales.whoi.edu timed out
// from the build VM on 2026-09-27 (curl 000 both endpoints; VM-throttled,
// needs a Worker-side probe). Shapes follow the catalog fields for #140/#141
// ("JSON: platform/datetime/lat/lon/analyst/species", "JSON 16 buoys") plus
// WordPress REST conventions.

const DETECTIONS_FIXTURE = [
  { platform: 'NY Bight buoy', datetime: '2026-09-27T10:28:30Z', lat: 40.45, lon: -73.82, analyst: 'Dr. Baumgartner', species: 'North Atlantic right whale' },
  { platform: 'Outer Fall glider', datetime: '2026-09-27T09:11:02Z', lat: 43.2, lon: -70.1, analyst: 'auto', species: 'humpback' },
  { platform: 'Outer Fall glider', datetime: '2026-09-27T08:45:00Z', lat: 43.2, lon: -70.1, analyst: 'auto', species: 'fin' },
  { platform: 'No species row', datetime: '2026-09-27T08:00:00Z', lat: 43.2, lon: -70.1, analyst: 'auto' }, // filtered
  { platform: 'No coords row', datetime: '2026-09-27T07:00:00Z', species: 'blue', analyst: 'auto' }, // filtered
];

const DETECTIONS_WRAPPED = { data: [{ platform: 'w1', date: '2026-09-26T12:00:00Z', latitude: 41.0, longitude: -71.5, species: 'sei', analyst: 'rev' }] };

const PLATFORMS_FIXTURE = [
  { id: 'buoy-1', name: 'NY Bight', type: 'moored buoy', lat: 40.45, lon: -73.82 },
  { id: 'glider-7', name: 'Outer Fall glider', type: 'slocum glider', lat: 43.2, lon: -70.1 },
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

test('detectionArray accepts bare arrays and data wrappers', () => {
  assert.equal(detectionArray(DETECTIONS_FIXTURE).length, 5);
  assert.equal(detectionArray(DETECTIONS_WRAPPED).length, 1);
  assert.deepEqual(detectionArray(null), []);
});

test('normalizeSpecies maps program species and free text', () => {
  assert.equal(normalizeSpecies('North Atlantic right whale'), 'right');
  assert.equal(normalizeSpecies('Humpback'), 'humpback');
  assert.equal(normalizeSpecies('fin'), 'fin');
  assert.equal(normalizeSpecies('sei'), 'sei');
  assert.equal(normalizeSpecies('Blue Whale'), 'blue');
  assert.equal(normalizeSpecies('sperm whale'), 'other');
  assert.equal(normalizeSpecies(''), null);
  assert.equal(normalizeSpecies(null), null);
});

test('trimDetection keeps species + coords, drops malformed rows', () => {
  const kept = DETECTIONS_FIXTURE.map(trimDetection).filter(Boolean);
  assert.equal(kept.length, 3);
  const first = kept[0];
  assert.equal(first.species, 'right');
  assert.equal(first.speciesRaw, 'North Atlantic right whale');
  assert.equal(first.platform, 'NY Bight buoy');
  assert.equal(first.lat, 40.45);
  assert.equal(first.datetime, '2026-09-27T10:28:30.000Z');
  assert.equal(first.analyst, 'Dr. Baumgartner');
});

test('trimDetection tolerates alternate key spellings', () => {
  const d = trimDetection(DETECTIONS_WRAPPED.data[0]);
  assert.equal(d.species, 'sei');
  assert.equal(d.lat, 41);
  assert.equal(d.lon, -71.5);
  assert.equal(d.datetime, '2026-09-26T12:00:00.000Z');
});

test('trimPlatform maps buoy metadata, filters coordless', () => {
  const kept = PLATFORMS_FIXTURE.map(trimPlatform).filter(Boolean);
  assert.equal(kept.length, 2);
  assert.equal(kept[0].id, 'buoy-1');
  assert.equal(kept[0].type, 'moored buoy');
  assert.equal(trimPlatform({ id: 'x' }), null);
});

test('buildSnapshot sorts newest-first and counts species', () => {
  const snap = buildSnapshot([
    { key: 'detections', ok: true, count: 3, latencyMs: 5, items: DETECTIONS_FIXTURE.map(trimDetection).filter(Boolean) },
    { key: 'platforms', ok: true, count: 2, latencyMs: 5, items: PLATFORMS_FIXTURE.map(trimPlatform).filter(Boolean) },
  ]);
  assert.equal(snap.count, 3);
  assert.equal(snap.platformCount, 2);
  assert.equal(snap.detections[0].species, 'right'); // newest first
  assert.deepEqual(snap.speciesCounts, { right: 1, humpback: 1, fin: 1 });
  assert.ok(snap.attribution.includes('Woods Hole'));
});

test('buildSnapshot degrades honestly when platforms fail', () => {
  const snap = buildSnapshot([
    { key: 'detections', ok: true, count: 1, latencyMs: 5, items: [trimDetection(DETECTIONS_FIXTURE[0])] },
    { key: 'platforms', ok: false, count: 0, latencyMs: 5, error: 'whales_upstream_503', items: [] },
  ]);
  assert.equal(snap.count, 1);
  assert.equal(snap.platforms.length, 0);
  assert.equal(snap.sources.platforms.ok, false);
});

test('provider mounts /api/whales and rejects non-GET', async () => {
  const calls = mount(whalesProxy());
  assert.ok(calls.some((c) => c.route === '/api/whales'));
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/whales', 'POST'), res);
  assert.equal(res.statusCode, 405);
});

test('handler returns 200 on live-shaped fixture bodies', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = String(url).includes('platforms') ? PLATFORMS_FIXTURE : DETECTIONS_FIXTURE;
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    clearCaches();
    const { handler } = mount(whalesProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/whales'), res);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.count, 3);
    assert.equal(parsed.platformCount, 2);
    assert.equal(parsed.detections[0].species, 'right');
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
    const { handler } = mount(whalesProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/whales'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'whales_unavailable');
    assert.ok(res.headers['Cache-Control'].includes('no-store'));
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
