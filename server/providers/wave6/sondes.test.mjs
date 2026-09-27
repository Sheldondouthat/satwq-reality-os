import assert from 'node:assert/strict';
import test from 'node:test';
import { sondesProxy, _sondesInternals } from './sondes.js';

const { trimSonde, trimSondesPayload, clearCaches } = _sondesInternals;

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

function fakeReq(method = 'GET') {
  return { method, url: '/api/sondes', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('sondesProxy mounts /api/sondes on both server shapes', () => {
  const routes = mount(sondesProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/sondes', '/api/sondes']);
});

const SONDES_FIXTURE = {
  'S1234567': {
    lat: 51.5074, lon: -0.1278, alt: 12000.5, type: 'RS41', subtype: 'RS41-SG',
    uploader: 'G0CALL', time: '2026-09-27T12:00:00.000Z',
  },
  'S7654321': {
    lat: 40.7128, lon: -74.006, alt: 5.2, type: 'DFM17',
    uploader_callsign: 'K1ABC', time: '2026-09-27T11:55:00.000Z',
  },
  'S0000000': {
    lat: 'not-a-number', lon: 10, alt: 100, type: 'RS41', time: '2026-09-27T11:00:00.000Z',
  },
  'S9999999': {
    lat: 91, lon: 0, alt: 100, type: 'RS41', time: '2026-09-27T11:00:00.000Z',
  },
};

test('trimSonde parses a full RS41 record', () => {
  const s = trimSonde('S1234567', SONDES_FIXTURE['S1234567']);
  assert.ok(s);
  assert.equal(s.serial, 'S1234567');
  assert.equal(s.lat, 51.5074);
  assert.equal(s.lon, -0.1278);
  assert.equal(s.altM, 12000.5);
  assert.equal(s.type, 'RS41');
  assert.equal(s.subtype, 'RS41-SG');
  assert.equal(s.uploader, 'G0CALL');
  assert.equal(s.lastSeen, '2026-09-27T12:00:00.000Z');
});

test('trimSonde falls back to uploader_callsign and drops bad coordinates', () => {
  const s = trimSonde('S7654321', SONDES_FIXTURE['S7654321']);
  assert.ok(s);
  assert.equal(s.uploader, 'K1ABC');
  assert.equal(trimSonde('S0000000', SONDES_FIXTURE['S0000000']), null);
  assert.equal(trimSonde('S9999999', SONDES_FIXTURE['S9999999']), null, 'lat 91 is out of range');
});

test('trimSondesPayload counts airborne sondes and sorts newest-first', () => {
  const payload = trimSondesPayload(SONDES_FIXTURE);
  assert.equal(payload.count, 2);
  assert.equal(payload.airborne, 1, 'only the 12 km sonde is airborne (>100 m)');
  assert.equal(payload.sondes[0].serial, 'S1234567', 'newest lastSeen first');
  assert.equal(payload.band, '400-406 MHz (meteorological aids)');
});

test('trimSondesPayload handles non-object upstreams gracefully', () => {
  assert.equal(trimSondesPayload(null).count, 0);
  assert.equal(trimSondesPayload([]).count, 0);
  assert.equal(trimSondesPayload('junk').count, 0);
});

test('handler returns 502 JSON when the upstream is down', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const [{ handler }] = mount(sondesProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'sondes_unavailable');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler serves fixture on 200 and caches it', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(SONDES_FIXTURE), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const [{ handler }] = mount(sondesProxy());
    const res1 = fakeRes();
    await handler(fakeReq('GET'), res1);
    assert.equal(res1.statusCode, 200);
    assert.equal(JSON.parse(res1.body).count, 2);
    const res2 = fakeRes();
    await handler(fakeReq('GET'), res2);
    assert.equal(fetchCalls, 1, 'second request must come from the TTL cache');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
