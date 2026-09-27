import assert from 'node:assert/strict';
import test from 'node:test';
import { aircraftProxy, _aircraftInternals } from './aircraft.js';

const {
  parseOpenSky,
  parseAdsbLol,
  normalizeAircraft,
  dedupeAircraft,
  buildSnapshot,
  ADSB_LOL_HUBS,
  ADSB_LOL_URLS,
  clearCaches,
} = _aircraftInternals;

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

// ——— fixtures (documented OpenSky state-vector + adsb.lol shapes) ———

const OPENSKY_FIXTURE = {
  time: 1759000000,
  states: [
    // [icao24, callsign, origin_country, time_position, last_contact(epoch s),
    //  longitude, latitude, baro_altitude(m), on_ground, velocity(m/s),
    //  true_track, vertical_rate(m/s), sensors, geo_altitude(m), squawk, spi, position_source]
    ['a3b4c5', 'UAL123  ', 'United States', 1758999990, 1759000000, -80.7, 37.27, 10000, false, 230, 270.0, 0.0, null, 10000, '1234', false, 0],
    ['d4e5f6', 'DLH456  ', 'Germany', 1758999980, 1759000000, -0.45, 51.47, 11000, false, 250, 90.5, -5.0, null, 11000, null, false, 0],
    ['', 'junk', 'Nowhere', 0, 0, 0, 0, 0, false, 0, 0, 0, null, 0, null, false, 0], // junk: no icao24, dropped
    ['112233', 'NOCOORD ', 'Nowhere', 0, 0, null, null, 0, false, 0, 0, 0, null, 0, null, false, 0], // junk: no coords, dropped
  ],
};

const ADSB_LOL_FIXTURE = {
  now: 1759000000,
  msg: 12,
  ac: [
    {
      hex: 'A3B4C5', type: 'adsb_icao', flight: 'UAL123', r: 'N12345', t: 'B739',
      alt_baro: 32000, gs: 450.0, track: 271.0, lat: 37.28, lon: -80.71,
      squawk: '1234', baro_rate: 0, seen: 1.2,
    },
    {
      hex: '778899', type: 'adsb_icao', flight: 'SAS999', r: 'SE-RPT', t: 'A320',
      alt_baro: 'ground', gs: 12.0, track: 180.0, lat: 55.62, lon: 12.64,
      squawk: '2000', baro_rate: 0, seen: 0.8,
    },
    { hex: '', flight: 'junk' }, // junk: dropped
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

test('parseOpenSky converts units and drops junk states', () => {
  const out = parseOpenSky(OPENSKY_FIXTURE);
  assert.equal(out.length, 2);
  const a = out.find((x) => x.icao24 === 'a3b4c5');
  assert.equal(a.callsign, 'UAL123'); // trailing spaces trimmed
  assert.equal(a.originCountry, 'United States');
  assert.equal(a.lat, 37.27);
  assert.equal(a.lon, -80.7);
  assert.equal(a.altitudeFt, Math.round(10000 * 3.28084)); // m → ft
  assert.equal(a.speedKts, Math.round(230 * 1.94384 * 10) / 10); // m/s → kt
  assert.equal(a.trackDeg, 270);
  assert.equal(a.verticalRateFpm, Math.round(0 * 196.85));
  assert.equal(a.squawk, '1234');
  assert.equal(a.onGround, false);
  assert.equal(a.lastContact, new Date(1759000000 * 1000).toISOString()); // epoch s
  assert.deepEqual(a.sources, ['opensky']);
});

test('parseOpenSky prefers geo_altitude, falls back to baro_altitude', () => {
  const body = { states: [['abc123', 'TST1', 'X', 0, 1759000000, 1, 1, 9000, false, 100, 0, 0, null, null, null, false, 0]] };
  const [a] = parseOpenSky(body);
  assert.equal(a.altitudeFt, Math.round(9000 * 3.28084)); // geo null → baro used
});

test('parseAdsbLol reads flight/reg/type, ground state, and relative seen time', () => {
  const nowMs = 1759000000000;
  const out = parseAdsbLol(ADSB_LOL_FIXTURE, nowMs);
  assert.equal(out.length, 2);
  const a = out.find((x) => x.icao24 === 'a3b4c5');
  assert.equal(a.icao24, 'a3b4c5'); // hex normalized lowercase
  assert.equal(a.callsign, 'UAL123');
  assert.equal(a.reg, 'N12345');
  assert.equal(a.type, 'B739');
  assert.equal(a.altitudeFt, 32000);
  assert.equal(a.onGround, null);
  assert.equal(a.speedKts, 450);
  assert.equal(a.lastContact, new Date(nowMs - 1.2 * 1000).toISOString()); // `seen` seconds ago
  const g = out.find((x) => x.icao24 === '778899');
  assert.equal(g.onGround, true);
  assert.equal(g.altitudeFt, null); // 'ground' altitude → null
  assert.deepEqual(g.sources, ['adsb_lol']);
});

test('normalizeAircraft rejects bad icao24/coords', () => {
  assert.equal(normalizeAircraft({ icao24: null, lat: 1, lon: 1, source: 'x' }), null);
  assert.equal(normalizeAircraft({ icao24: 'abc', lat: 95, lon: 1, source: 'x' }), null);
  const a = normalizeAircraft({ icao24: 'ABC123', lat: 1.2345678, lon: -2.3456789, source: 'x' });
  assert.equal(a.icao24, 'abc123');
  assert.equal(a.lat, 1.2346);
  assert.equal(a.lon, -2.3457);
});

// ——— dedupe/merge tests ———

test('dedupeAircraft merges same ICAO24 across sources, fresher position wins', () => {
  const fromOpenSky = normalizeAircraft({
    icao24: 'a3b4c5', callsign: 'UAL123', originCountry: 'United States',
    reg: null, type: null, lat: 37.27, lon: -80.7, altitudeFt: 32808,
    onGround: false, speedKts: 447, trackDeg: 270, verticalRateFpm: 0,
    squawk: null, lastContact: '2026-09-27T16:00:00.000Z', source: 'opensky',
  });
  const fromLol = normalizeAircraft({
    icao24: 'A3B4C5', callsign: null, originCountry: null,
    reg: 'N12345', type: 'B739', lat: 37.28, lon: -80.71, altitudeFt: 32000,
    onGround: false, speedKts: 450, trackDeg: 271, verticalRateFpm: 0,
    squawk: '1234', lastContact: '2026-09-27T17:00:00.000Z', source: 'adsb_lol',
  });
  const merged = dedupeAircraft([fromOpenSky, fromLol]);
  assert.equal(merged.length, 1);
  const a = merged[0];
  assert.equal(a.lat, 37.28); // fresher adsb.lol position wins
  assert.equal(a.reg, 'N12345'); // enrichment kept
  assert.equal(a.type, 'B739');
  assert.equal(a.callsign, 'UAL123'); // backfilled from the older OpenSky report
  assert.equal(a.originCountry, 'United States');
  assert.deepEqual(a.sources.sort(), ['adsb_lol', 'opensky']);
});

test('adsb.lol hub list covers bounded queries only, no /v2/all', () => {
  assert.ok(ADSB_LOL_HUBS.length >= 2);
  for (const url of ADSB_LOL_URLS) assert.ok(!url.includes('/v2/all'), 'must never use /v2/all (503s)');
  assert.ok(ADSB_LOL_URLS.every((u) => /\/dist\/\d+/.test(u)), 'all queries are bounded radius');
});

// ——— snapshot tests ———

test('buildSnapshot unions counts and records per-source failures', () => {
  const a = normalizeAircraft({ icao24: 'aaaaaa', lat: 1, lon: 1, source: 'opensky' });
  const snap = buildSnapshot([
    { key: 'opensky', ok: true, count: 1, attribution: 'OpenSky', latencyMs: 5, aircraft: [a] },
    { key: 'adsb_lol', ok: false, count: 0, attribution: 'adsb.lol', latencyMs: 5, error: 'fetch failed', aircraft: [] },
  ]);
  assert.equal(snap.count, 1);
  assert.equal(snap.sources.opensky.ok, true);
  assert.equal(snap.sources.adsb_lol.ok, false);
  assert.equal(snap.sources.adsb_lol.error, 'fetch failed');
  assert.ok(Date.parse(snap.generatedAt));
});

// ——— handler tests (fetch-mocked) ———

test('handler aggregates OpenSky + adsb.lol with mocked fetch', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchFor({ 'states/all': OPENSKY_FIXTURE, 'api.adsb.lol': ADSB_LOL_FIXTURE });
  try {
    const [call] = mount(aircraftProxy());
    assert.equal(call.route, '/api/aircraft');
    const req = fakeReq('/api/aircraft');
    const res = fakeRes();
    await call.handler(req, res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.aircraft));
    assert.equal(body.sources.opensky.ok, true);
    assert.equal(body.sources.adsb_lol.ok, true);
    assert.ok(body.count >= 3); // 2 opensky + 2 adsb.lol − 1 merged dup
    const dup = body.aircraft.find((a) => a.icao24 === 'a3b4c5');
    assert.deepEqual(dup.sources.sort(), ['adsb_lol', 'opensky']);
    assert.equal(dup.reg, 'N12345');
    assert.ok(res.headers['Cache-Control'].includes('max-age=30'));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns honest 502 when every source fails', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw Object.assign(new Error('socket hang up'), { name: 'AbortError' }); };
  try {
    const [call] = mount(aircraftProxy());
    const res = fakeRes();
    await call.handler(fakeReq('/api/aircraft'), res);
    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'aircraft_unavailable');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const [call] = mount(aircraftProxy());
  const res = fakeRes();
  await call.handler(fakeReq('/api/aircraft', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
