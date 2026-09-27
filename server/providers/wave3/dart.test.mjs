import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DART_REGISTRY,
  SUBDUCTION_ZONES,
  haversineKm,
  subductionZoneFor,
  qualifiesForCoupling,
  nearestDartBuoys,
  parseDartText,
  normalizeUsgsFeatures,
  dartCouplingProxy,
} from './dart.js';

test('haversineKm: Tokyo–Honolulu is ~6200 km', () => {
  const d = haversineKm(35.7, 139.7, 21.3, -157.8);
  assert.ok(d > 6000 && d < 6500, `got ${d}`);
});

test('haversineKm: same point is zero', () => {
  assert.equal(haversineKm(10, 20, 10, 20), 0);
});

test('subductionZoneFor: Aleutian epicenter maps to Aleutian Trench', () => {
  assert.equal(subductionZoneFor(52.9, -171.5), 'Aleutian Trench');
});

test('subductionZoneFor: mid-ocean point maps to null', () => {
  assert.equal(subductionZoneFor(0, -140), null);
});

test('subductionZoneFor: invalid input maps to null', () => {
  assert.equal(subductionZoneFor(NaN, 0), null);
  assert.equal(subductionZoneFor(10, Infinity), null);
});

test('qualifiesForCoupling: M6.5 shallow subduction quake qualifies', () => {
  const zone = qualifiesForCoupling({ mag: 6.5, depthKm: 33, lat: 52.9, lon: -171.5 });
  assert.equal(zone, 'Aleutian Trench');
});

test('qualifiesForCoupling: M6.4 does not qualify', () => {
  assert.equal(qualifiesForCoupling({ mag: 6.4, depthKm: 33, lat: 52.9, lon: -171.5 }), null);
});

test('qualifiesForCoupling: deep quake does not qualify', () => {
  assert.equal(qualifiesForCoupling({ mag: 7.2, depthKm: 250, lat: 52.9, lon: -171.5 }), null);
});

test('qualifiesForCoupling: M6.5 far from any subduction zone does not qualify', () => {
  assert.equal(qualifiesForCoupling({ mag: 7.0, depthKm: 10, lat: 0, lon: -140 }), null);
});

test('nearestDartBuoys: Aleutian quake ranks Alaska-region buoys first, distance-ranked', () => {
  const buoys = nearestDartBuoys(52.9, -171.5, { limit: 4 });
  assert.equal(buoys.length, 4);
  // Per the approximate registry, Gulf-of-Alaska 46402 is the geometric
  // nearest to this epicenter; the rule only promises distance ranking.
  assert.ok(['46402', '46403', '21414', '21415'].includes(buoys[0].id), `nearest was ${buoys[0].id}`);
  for (let i = 1; i < buoys.length; i++) {
    assert.ok(buoys[i].distKm >= buoys[i - 1].distKm, 'must be distance-ranked');
  }
});

test('nearestDartBuoys: tiny radius returns empty', () => {
  assert.deepEqual(nearestDartBuoys(0, 0, { radiusKm: 100, limit: 5 }), []);
});

test('DART_REGISTRY: every entry has id/lat/lon and a name', () => {
  for (const b of DART_REGISTRY) {
    assert.match(b.id, /^\d+$/);
    assert.ok(Math.abs(b.lat) <= 90 && Math.abs(b.lon) <= 180);
    assert.ok(typeof b.name === 'string' && b.name.length > 0);
  }
});

test('SUBDUCTION_ZONES: boxes are well-formed', () => {
  for (const z of SUBDUCTION_ZONES) {
    assert.equal(z.box.length, 4);
    const [minLon, maxLon, minLat, maxLat] = z.box;
    assert.ok(minLon <= maxLon && minLat <= maxLat);
  }
});

test('parseDartText: parses the live NDBC format (verified 2026-09-27)', () => {
  const text =
    '#YY  MM DD hh mm ss T   HEIGHT\n' +
    '#yr  mo dy hr mn  s -        m\n' +
    '2026 09 27 00 00 00 1 2737.005\n' +
    '2026 09 26 21 00 00 1 2738.194\n' +
    '2026 09 26 18 00 00 1 2739.000\n';
  const r = parseDartText(text, Date.UTC(2026, 8, 27, 1, 0, 0));
  assert.ok(r);
  assert.equal(r.waterColumnM, 2737.005);
  assert.equal(r.timeMs, Date.UTC(2026, 8, 27, 0, 0, 0));
  assert.ok(Math.abs(r.change3hM - (2737.005 - 2738.194)) < 1e-9);
});

test('parseDartText: skips invalid rows and flag != 1', () => {
  const text = '#YY MM DD hh mm ss T HEIGHT\n2026 09 27 00 00 00 0 2737.005\n';
  assert.equal(parseDartText(text), null);
});

test('normalizeUsgsFeatures: keeps valid quakes, drops malformed', () => {
  const rows = normalizeUsgsFeatures({
    features: [
      {
        properties: { mag: 6.6, place: 'X', time: 1, ids: ',us123,' },
        geometry: { coordinates: [-171.5, 52.9, 33] },
      },
      { properties: { mag: null }, geometry: { coordinates: [0, 0, 0] } },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mag, 6.6);
  assert.equal(rows[0].id, ',us123,');
});

test('normalizeUsgsFeatures: non-array features returns null', () => {
  assert.equal(normalizeUsgsFeatures({}), null);
});

function stubFetch(routes) {
  return async (url) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (!key) throw new Error(`unexpected url ${url}`);
    const value = routes[key];
    if (value instanceof Error) throw value;
    return { ok: true, text: async () => value, body: { cancel: async () => {} } };
  };
}

function fakeReqRes(url = '/api/dart-coupling') {
  const req = { method: 'GET', url, headers: {}, on: () => {}, removeListener: () => {} };
  const chunks = [];
  const res = {
    statusCode: null,
    headers: null,
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { chunks.push(body); },
    once: () => {},
    removeListener: () => {},
  };
  return { req, res, body: () => JSON.parse(chunks.join('')) };
}

const DART_SAMPLE =
  '#YY  MM DD hh mm ss T   HEIGHT\n2026 09 27 00 00 00 1 5432.100\n2026 09 26 21 00 00 1 5432.050\n';

test('handler: end-to-end with stubbed USGS/NDBC/NWS', async () => {
  const usgs = JSON.stringify({
    features: [
      {
        properties: { mag: 6.5, place: '177 km W of Nikolski, Alaska', time: 1758950000000, ids: ',us7000ti1p,' },
        geometry: { coordinates: [-171.5033, 52.9564, 33] },
      },
      {
        properties: { mag: 5.1, place: 'small one', time: 1758950000000, ids: ',xx1,' },
        geometry: { coordinates: [-171.5, 52.9, 10] },
      },
    ],
  });
  const proxy = dartCouplingProxy({
    fetchImpl: stubFetch({
      'earthquake.usgs.gov': usgs,
      'ndbc.noaa.gov': DART_SAMPLE,
      'api.weather.gov': JSON.stringify({ features: [] }),
    }),
    now: () => 1758950400000,
  });
  const { req, res, body } = fakeReqRes();
  await new Promise((resolve) => {
    const origEnd = res.end.bind(res);
    res.end = (b) => { origEnd(b); resolve(); };
    proxy.configureServer({ middlewares: { use: (route, handler) => handler(req, res) } });
  });
  const payload = body();
  assert.equal(res.statusCode, 200);
  assert.equal(payload.schemaVersion, 1);
  assert.equal(payload.quakes.length, 1, 'only the M6.5 quake couples');
  const q = payload.quakes[0];
  assert.equal(q.subductionZone, 'Aleutian Trench');
  assert.ok(q.buoys.length >= 1);
  assert.equal(q.buoys[0].status, 'live');
  assert.equal(q.buoys[0].waterColumnM, 5432.1);
  assert.ok(q.honesty === undefined, 'honesty note lives at top level');
  assert.match(payload.honesty, /NOT a tsunami forecast/);
});

test('handler: rejects non-GET', async () => {
  const proxy = dartCouplingProxy({ fetchImpl: stubFetch({}) });
  const { req, res, body } = fakeReqRes();
  req.method = 'POST';
  await new Promise((resolve) => {
    const origEnd = res.end.bind(res);
    res.end = (b) => { origEnd(b); resolve(); };
    proxy.configureServer({ middlewares: { use: (route, handler) => handler(req, res) } });
  });
  assert.equal(res.statusCode, 405);
  assert.equal(body().error, 'method_not_allowed');
});
