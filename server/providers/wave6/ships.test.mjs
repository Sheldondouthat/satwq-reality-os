import assert from 'node:assert/strict';
import test from 'node:test';
import { shipsProxy, _shipsInternals } from './ships.js';

const {
  parseAiscast,
  parseDigitraffic,
  parseEuRis,
  normalizeShip,
  normalizeMmsi,
  dedupeShips,
  buildSnapshot,
  clearCaches,
} = _shipsInternals;

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

// ——— fixtures (documented GeoJSON + track-list shapes) ———

const AISCAST_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      id: '232000111',
      geometry: { type: 'Point', coordinates: [-4.5, 48.4] },
      properties: {
        mmsi: 232000111, imo: '9333333', name: 'MERMAID VOYAGER',
        speed: 12.5, course: 135.2, heading: 135,
        navStatus: 'Under way using engine', shipType: 'Cargo',
        destination: 'ROTTERDAM', lastUpdate: '2026-09-27T16:00:00.000Z',
      },
    },
    { type: 'Feature', id: 'x', geometry: null, properties: {} }, // junk: dropped
  ],
};

const DIGITRAFFIC_FIXTURE = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [24.94, 60.16] },
      properties: {
        mmsi: 230000222, name: 'BALTIC STAR', sog: 8.3, cog: 92.0, heading: 90,
        navStat: 'Under way using engine', shipType: 'Passenger',
        timestampExternal: '2026-09-27T16:30:00.000Z',
      },
    },
  ],
};

const EURIS_FIXTURE = {
  tracks: [
    {
      mmsi: '203000333', name: 'RHINE QUEEN', lat: 51.88, lon: 4.48,
      speed: 6.2, course: 180.0, heading: 180,
      shipType: 'Inland cargo', destination: 'DUISBURG',
      lastUpdate: '2026-09-27T16:10:00.000Z',
    },
  ],
};

function mockFetchFor(bodies) {
  return async (url) => {
    const keys = Object.keys(bodies);
    const hit = keys.find((k) => String(url).includes(k));
    if (hit === undefined) {
      return { ok: false, status: 404, async arrayBuffer() { return new ArrayBuffer(0); } };
    }
    const text = JSON.stringify(bodies[hit]);
    return {
      ok: true,
      status: 200,
      async arrayBuffer() { return new TextEncoder().encode(text).buffer; },
    };
  };
}

// ——— parse tests ———

test('normalizeMmsi accepts 9-digit identities only', () => {
  assert.equal(normalizeMmsi(232000111), '232000111');
  assert.equal(normalizeMmsi('232000111'), '232000111');
  assert.equal(normalizeMmsi('123'), null);
  assert.equal(normalizeMmsi('abc'), null);
  assert.equal(normalizeMmsi(null), null);
  assert.equal(normalizeMmsi('2320-00111'), '232000111');
});

test('parseAiscast normalizes GeoJSON vessel features', () => {
  const out = parseAiscast(AISCAST_FIXTURE);
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(s.mmsi, '232000111');
  assert.equal(s.imo, '9333333');
  assert.equal(s.name, 'MERMAID VOYAGER');
  assert.equal(s.lat, 48.4);
  assert.equal(s.lon, -4.5);
  assert.equal(s.speedKts, 12.5);
  assert.equal(s.courseDeg, 135.2);
  assert.equal(s.headingDeg, 135);
  assert.equal(s.navStatus, 'Under way using engine');
  assert.equal(s.shipType, 'Cargo');
  assert.equal(s.destination, 'ROTTERDAM');
  assert.equal(s.lastUpdate, '2026-09-27T16:00:00.000Z');
  assert.deepEqual(s.sources, ['aiscast']);
});

test('parseDigitraffic reads sog/cog/timestampExternal', () => {
  const out = parseDigitraffic(DIGITRAFFIC_FIXTURE);
  assert.equal(out.length, 1);
  const s = out[0];
  assert.equal(s.mmsi, '230000222');
  assert.equal(s.name, 'BALTIC STAR');
  assert.equal(s.lat, 60.16);
  assert.equal(s.lon, 24.94);
  assert.equal(s.speedKts, 8.3);
  assert.equal(s.courseDeg, 92);
  assert.equal(s.headingDeg, 90);
  assert.equal(s.navStatus, 'Under way using engine');
  assert.equal(s.lastUpdate, '2026-09-27T16:30:00.000Z');
  assert.deepEqual(s.sources, ['digitraffic']);
});

test('parseEuRis accepts track lists, bare arrays, and GeoJSON', () => {
  assert.equal(parseEuRis(EURIS_FIXTURE).length, 1);
  const asArray = parseEuRis(EURIS_FIXTURE.tracks);
  assert.equal(asArray.length, 1);
  const asGeo = parseEuRis({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [4.48, 51.88] },
      properties: { mmsi: '203000333', name: 'RHINE QUEEN' },
    }],
  });
  assert.equal(asGeo.length, 1);
  const s = parseEuRis(EURIS_FIXTURE)[0];
  assert.equal(s.mmsi, '203000333');
  assert.equal(s.shipType, 'Inland cargo');
  assert.deepEqual(s.sources, ['euris']);
  assert.equal(parseEuRis({ nonsense: true }).length, 0);
});

test('normalizeShip rejects bad mmsi/coords', () => {
  assert.equal(normalizeShip({ mmsi: '123', lat: 1, lon: 1, source: 'x' }), null);
  assert.equal(normalizeShip({ mmsi: '232000111', lat: 200, lon: 1, source: 'x' }), null);
  const s = normalizeShip({ mmsi: '232000111', lat: 1.2345678, lon: -2.3456789, source: 'x' });
  assert.equal(s.mmsi, '232000111');
  assert.equal(s.lat, 1.2346);
  assert.equal(s.name, null);
  assert.equal(s.lastUpdate, null);
});

// ——— dedupe/merge tests ———

test('dedupeShips merges same MMSI across sources, fresher position wins', () => {
  const fromAiscast = normalizeShip({
    mmsi: '232000111', imo: null, name: 'MERMAID VOYAGER',
    lat: 48.4, lon: -4.5, speedKts: 12.5, courseDeg: 135.2, headingDeg: 135,
    navStatus: null, shipType: 'Cargo', draughtM: null, destination: 'ROTTERDAM',
    lastUpdate: '2026-09-27T16:00:00.000Z', source: 'aiscast',
  });
  const fromDigitraffic = normalizeShip({
    mmsi: '232000111', imo: '9333333', name: null,
    lat: 48.41, lon: -4.49, speedKts: 12.6, courseDeg: 136, headingDeg: 136,
    navStatus: 'Under way using engine', shipType: null, draughtM: 8.2, destination: null,
    lastUpdate: '2026-09-27T16:30:00.000Z', source: 'digitraffic',
  });
  const merged = dedupeShips([fromAiscast, fromDigitraffic]);
  assert.equal(merged.length, 1);
  const s = merged[0];
  assert.equal(s.lat, 48.41); // fresher Digitraffic position wins
  assert.equal(s.imo, '9333333');
  assert.equal(s.name, 'MERMAID VOYAGER'); // backfilled from the older aiscast report
  assert.equal(s.destination, 'ROTTERDAM');
  assert.equal(s.draughtM, 8.2);
  assert.deepEqual(s.sources.sort(), ['aiscast', 'digitraffic']);
});

// ——— snapshot tests ———

test('buildSnapshot records per-source failures honestly', () => {
  const s = normalizeShip({ mmsi: '232000111', lat: 1, lon: 1, source: 'aiscast' });
  const snap = buildSnapshot([
    { key: 'aiscast', ok: true, count: 1, attribution: 'A', latencyMs: 5, ships: [s] },
    { key: 'digitraffic', ok: true, count: 0, attribution: 'B', latencyMs: 5, ships: [] },
    { key: 'euris', ok: false, count: 0, attribution: 'C', latencyMs: 5, error: '404', ships: [] },
  ]);
  assert.equal(snap.count, 1);
  assert.equal(snap.sources.euris.ok, false);
  assert.equal(snap.sources.euris.error, '404');
  assert.ok(Date.parse(snap.generatedAt));
});

// ——— handler tests (fetch-mocked) ———

test('handler aggregates all three AIS sources with mocked fetch', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchFor({
    'openwaters.io': AISCAST_FIXTURE,
    'digitraffic.fi': DIGITRAFFIC_FIXTURE,
    'eurisportal.eu': EURIS_FIXTURE,
  });
  try {
    const [call] = mount(shipsProxy());
    assert.equal(call.route, '/api/ships');
    const res = fakeRes();
    await call.handler(fakeReq('/api/ships'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.ships));
    assert.equal(body.count, 3);
    assert.equal(body.sources.aiscast.ok, true);
    assert.equal(body.sources.digitraffic.ok, true);
    assert.equal(body.sources.euris.ok, true);
    assert.ok(res.headers['Cache-Control'].includes('max-age=120'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns honest 502 when every source fails', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('socket hang up'), { name: 'AbortError' }); };
  try {
    const [call] = mount(shipsProxy());
    const res = fakeRes();
    await call.handler(fakeReq('/api/ships'), res);
    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'ships_unavailable');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const [call] = mount(shipsProxy());
  const res = fakeRes();
  await call.handler(fakeReq('/api/ships', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
