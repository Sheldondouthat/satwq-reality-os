import assert from 'node:assert/strict';
import test from 'node:test';
import { potaProxy, _potaInternals } from './pota.js';

const { trimSpot, trimPark, trimPotaPayload, applyQuery } = _potaInternals;

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

const SAMPLE_SPOTS = [
  {
    spotId: 57667000,
    spotTime: '2026-09-27T19:38:59',
    activator: 'IU4SQE',
    frequency: '7074.0',
    mode: 'FT8',
    reference: 'IT-1136',
    spotter: 'YO2CK-#',
    source: 'RBN',
    comments: 'RBN -4 dB',
    name: 'Cassa di Espansione',
    locationDesc: 'IT-ER',
  },
  {
    spotId: 57666995,
    spotTime: '2026-09-27T19:38:55',
    activator: 'K2EAG/VE3',
    frequency: '21043.0',
    mode: 'CW',
    reference: 'CA-4883',
    spotter: 'NA7C',
    source: 'POTACAT',
    comments: '',
    name: 'Ridgeway Battlefield',
    locationDesc: 'CA-ON',
  },
  { spotId: null, frequency: 'junk', reference: '' }, // junk: no reference
];

const SAMPLE_PARKS = {
  'IT-1136': { parkId: 1, reference: 'IT-1136', latitude: 44.6123, longitude: 11.1234, name: 'Cassa' },
  'CA-4883': { parkId: 2, reference: 'CA-4883', latitude: 43.12345, longitude: -79.12345, name: 'Ridgeway' },
};

test('potaProxy mounts /api/pota on both server shapes', () => {
  const routes = mount(potaProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/pota', '/api/pota']);
});

test('trimSpot parses frequency and keeps fields', () => {
  const s = trimSpot(SAMPLE_SPOTS[0]);
  assert.equal(s.frequencyKhz, 7074.0);
  assert.equal(s.activator, 'IU4SQE');
  assert.equal(s.mode, 'FT8');
});

test('trimSpot handles bad frequency', () => {
  assert.equal(trimSpot({ frequency: 'junk' }).frequencyKhz, null);
});

test('trimPark rounds coords, rejects missing lat/lon', () => {
  const p = trimPark(SAMPLE_PARKS['CA-4883']);
  assert.equal(p.lat, 43.1235);
  assert.equal(p.lon, -79.1234);
  assert.equal(trimPark({ latitude: null, longitude: 1 }), null);
  assert.equal(trimPark(null), null);
});

test('trimPotaPayload drops spots without references', () => {
  const payload = trimPotaPayload(SAMPLE_SPOTS);
  assert.equal(payload.count, 2);
  assert.equal(payload.spots.length, 2);
  assert.ok(payload.honesty.includes('self/spotter'));
});

test('applyQuery filters by mode and caps limit', () => {
  const payload = trimPotaPayload(SAMPLE_SPOTS);
  const filtered = applyQuery(payload, 500, 'cw');
  assert.equal(filtered.count, 1);
  assert.equal(filtered.spots[0].activator, 'K2EAG/VE3');
  const capped = applyQuery(payload, 1, null);
  assert.equal(capped.spots.length, 1);
});

test('handler joins park coords with mocked fetch', async () => {
  const calls = mount(potaProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/park/')) {
      const ref = decodeURIComponent(u.split('/park/')[1]);
      const park = SAMPLE_PARKS[ref];
      if (!park) return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify(park), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify(SAMPLE_SPOTS), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/pota'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2);
    assert.equal(payload.withCoords, 2);
    assert.equal(payload.spots[0].lat, 44.6123);
    assert.equal(payload.spots[1].lon, -79.1234);
  } finally {
    globalThis.fetch = realFetch;
    _potaInternals.clearCaches();
  }
});

test('handler marks dead refs with null coords, still serves spots', async () => {
  const calls = mount(potaProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('/park/')) {
      return new Response('null', { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify([SAMPLE_SPOTS[0]]), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/pota'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.withCoords, 0);
    assert.equal(payload.spots[0].lat, null);
  } finally {
    globalThis.fetch = realFetch;
    _potaInternals.clearCaches();
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  _potaInternals.clearCaches();
  const calls = mount(potaProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/pota'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /pota_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(potaProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/pota', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
