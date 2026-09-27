import assert from 'node:assert/strict';
import test from 'node:test';
import { feltProxy, _feltInternals } from './felt.js';

const { trimFeltEvent, trimFeltPayload } = _feltInternals;

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

const SAMPLE_UPSTREAM = {
  type: 'FeatureCollection',
  name: 'EMSC felt earthquakes (last 72 hours)',
  features: [
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [-118.465, 33.84417] },
      properties: {
        name: 'Magnitude 3.5 earthquake near Torrance, United States',
        mag: 3.5,
        depth_km: 11.9,
        time: '2026-09-27T15:40:01+00:00',
        evid: '2066177',
        url: 'https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=2066177',
        feltReportCount: 88,
        testimonyCount: 42,
        mediaCount: 0,
      },
    },
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [21.16, 40.85] },
      properties: {
        name: 'Magnitude 3.2 earthquake near Grnčari, North Macedonia',
        mag: 3.2,
        depth_km: 0,
        time: '2026-09-27T12:04:01+00:00',
        evid: '2066107',
        url: 'https://www.emsc-csem.org/Earthquake_information/earthquake.php?id=2066107',
        feltReportCount: 33,
        testimonyCount: 10,
        mediaCount: 0,
      },
    },
    { type: 'Feature', geometry: null, properties: {} }, // junk: dropped
  ],
};

test('feltProxy mounts /api/felt on both server shapes', () => {
  const routes = mount(feltProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/felt', '/api/felt']);
});

test('trimFeltEvent rounds coords and keeps testimony counts', () => {
  const e = trimFeltEvent(SAMPLE_UPSTREAM.features[0]);
  assert.equal(e.id, '2066177');
  assert.equal(e.mag, 3.5);
  assert.equal(e.lon, -118.465);
  assert.equal(e.lat, 33.8442); // 4-decimal rounding
  assert.equal(e.testimonyCount, 42);
  assert.equal(e.feltReportCount, 88);
  assert.ok(Number.isFinite(e.timeMs));
});

test('trimFeltEvent tolerates missing counts as zero', () => {
  const e = trimFeltEvent({ properties: { evid: 'x' }, geometry: { type: 'Point', coordinates: [1, 2] } });
  assert.equal(e.testimonyCount, 0);
  assert.equal(e.mag, null);
  assert.equal(e.timeMs, null);
});

test('trimFeltPayload sorts by testimonyCount and sums testimonies', () => {
  const payload = trimFeltPayload(SAMPLE_UPSTREAM);
  assert.equal(payload.count, 2); // junk dropped
  assert.equal(payload.totalTestimonies, 52);
  assert.equal(payload.events[0].testimonyCount, 42);
  assert.equal(payload.window, 'rolling 72h');
});

test('handler serves trimmed snapshot with mocked fetch', async () => {
  const calls = mount(feltProxy());
  const realFetch = globalThis.fetch;
  const body = JSON.stringify(SAMPLE_UPSTREAM);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/geo+json' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/felt'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2);
    assert.equal(payload.events[0].id, '2066177');
    assert.match(res.headers['Cache-Control'], /max-age=600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  _feltInternals.clearCaches();
  const calls = mount(feltProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/felt'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /felt_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(feltProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/felt', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
