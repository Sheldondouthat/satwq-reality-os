import assert from 'node:assert/strict';
import test from 'node:test';
import { lightningProxy, _lightningInternals } from './lightning.js';

const { normalizeStrike, parseGlmStrikes, parseRealEarthTimes, buildSnapshot } = _lightningInternals;

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

const ARRAY_SHAPE = [
  { lat: 40.7128, lon: -74.006, time: '2026-09-27T16:00:00Z' },
  { latitude: 35.6762, longitude: 139.6503, timestamp: 1758990000 },
  { lat: 999, lon: 0, time: '2026-09-27T16:00:00Z' }, // junk coords: dropped
];

const GEOJSON_SHAPE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-97.5, 30.2] },
      properties: { time: '2026-09-27T15:59:00Z' },
    },
  ],
};

test('lightningProxy mounts /api/lightning on both server shapes', () => {
  const routes = mount(lightningProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/lightning', '/api/lightning']);
});

test('normalizeStrike handles field aliases and epoch seconds', () => {
  const s = normalizeStrike(ARRAY_SHAPE[1]);
  assert.equal(s.lat, 35.6762);
  assert.equal(s.lon, 139.6503);
  assert.equal(s.time, '2025-09-27T16:20:00.000Z'); // 1758990000 → UTC
});

test('normalizeStrike drops out-of-range coords', () => {
  assert.equal(normalizeStrike(ARRAY_SHAPE[2]), null);
  assert.equal(normalizeStrike(null), null);
});

test('parseGlmStrikes accepts a bare array and sorts newest first', () => {
  const out = parseGlmStrikes(ARRAY_SHAPE);
  assert.equal(out.length, 2);
  assert.equal(out[0].lat, 40.7128); // 16:00Z is newest
  assert.ok(out[0].time >= out[1].time);
});

test('parseGlmStrikes accepts GeoJSON', () => {
  const out = parseGlmStrikes(GEOJSON_SHAPE);
  assert.equal(out.length, 1);
  assert.equal(out[0].lon, -97.5);
  assert.equal(out[0].lat, 30.2);
});

test('parseGlmStrikes accepts {strikes:[...]} wrapper', () => {
  const out = parseGlmStrikes({ strikes: [{ lat: 10, lon: 20, time: '2026-09-27T16:00:00Z' }] });
  assert.equal(out.length, 1);
});

test('parseRealEarthTimes extracts latest time and template', () => {
  const t = parseRealEarthTimes({ products: { GOESEastGLMFEDRadC: { times: ['2026-09-27T15:50:00Z', '2026-09-27T16:00:00Z'] } } });
  assert.equal(t.timeCount, 2);
  assert.equal(t.latest, '2026-09-27T16:00:00.000Z');
  assert.match(t.tileUrlTemplate, /realearth/);
});

test('buildSnapshot records per-source status and merges strikes', () => {
  const strikes = parseGlmStrikes(ARRAY_SHAPE);
  const payload = buildSnapshot([
    { key: 'glm_mirror', ok: true, latencyMs: 42, data: strikes },
    { key: 'realearth', ok: false, latencyMs: 9, error: 'boom', data: null },
  ]);
  assert.equal(payload.count, 2);
  assert.equal(payload.sources.glm_mirror.ok, true);
  assert.equal(payload.sources.glm_mirror.count, 2);
  assert.equal(payload.sources.realearth.ok, false);
  assert.equal(payload.sources.realearth.error, 'boom');
  assert.equal(payload.tiles, null);
});

test('handler serves merged snapshot with mocked fetch', async () => {
  _lightningInternals.clearCaches();
  const calls = mount(lightningProxy());
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url) => {
    n += 1;
    const body = n === 1
      ? JSON.stringify(ARRAY_SHAPE)
      : JSON.stringify({ products: { GOESEastGLMFEDRadC: { times: ['2026-09-27T16:00:00Z'] } } });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/lightning'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2);
    assert.equal(payload.tiles.latest, '2026-09-27T16:00:00.000Z');
    assert.match(res.headers['Cache-Control'], /max-age=600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when all upstreams are down', async () => {
  _lightningInternals.clearCaches();
  const calls = mount(lightningProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 500 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/lightning'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /lightning_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler still returns 200 when only one source fails', async () => {
  _lightningInternals.clearCaches();
  const calls = mount(lightningProxy());
  const realFetch = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () => {
    n += 1;
    return n === 1
      ? new Response(JSON.stringify(ARRAY_SHAPE), { status: 200 })
      : new Response('down', { status: 503 });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/lightning'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.sources.realearth.ok, false);
    assert.equal(payload.count, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(lightningProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/lightning', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
