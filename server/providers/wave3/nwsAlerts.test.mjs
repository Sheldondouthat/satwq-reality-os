import assert from 'node:assert/strict';
import test from 'node:test';
import { nwsAlertsProxy, _nwsAlertsInternals } from './nwsAlerts.js';

const { trimGeometry, trimAlert, trimNwsAlertsPayload } = _nwsAlertsInternals;

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
  features: [
    {
      id: 'https://api.weather.gov/alerts/urn:oid:1',
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [[[-75.0, 40.0], [-74.0, 40.0], [-74.0, 41.0], [-75.0, 40.0]]],
      },
      properties: {
        id: 'urn:oid:1',
        event: 'Tornado Warning',
        headline: 'Tornado Warning issued for Test County',
        description: 'A tornado has been spotted.',
        severity: 'Extreme',
        certainty: 'Observed',
        urgency: 'Immediate',
        effective: '2026-09-27T01:00:00-04:00',
        expires: '2026-09-27T02:00:00-04:00',
        senderName: 'NWS Test',
        areaDesc: 'Test County',
        affectedZones: ['https://api.weather.gov/zones/county/ABC001'],
      },
    },
    {
      id: 'https://api.weather.gov/alerts/urn:oid:2',
      type: 'Feature',
      geometry: null, // marine/zone-referenced alerts carry no polygon
      properties: {
        id: 'urn:oid:2',
        event: 'Small Craft Advisory',
        severity: 'Minor',
        affectedZones: [],
      },
    },
    { id: '', type: 'Feature', geometry: null, properties: {} }, // junk: dropped
  ],
};

test('nwsAlertsProxy mounts /api/nws-alerts on both server shapes', () => {
  const routes = mount(nwsAlertsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/nws-alerts', '/api/nws-alerts']);
});

test('trimGeometry passes Polygon through, drops MultiLineString/other, rounds coords', () => {
  const g = trimGeometry(SAMPLE_UPSTREAM.features[0].geometry);
  assert.equal(g.type, 'Polygon');
  assert.equal(g.coordinates[0][0][0], -75.0);
  assert.equal(trimGeometry({ type: 'Point', coordinates: [1, 2] }), null);
  assert.equal(trimGeometry(null), null);
});

test('trimAlert caps long descriptions and keeps zone refs', () => {
  const a = trimAlert({ id: 'x', geometry: null, properties: { event: 'E', description: 'y'.repeat(5000) } });
  assert.equal(a.description.length, 2001);
  assert.ok(a.description.endsWith('…'));
});

test('trimNwsAlertsPayload counts alerts and geometry-bearing subset', () => {
  const payload = trimNwsAlertsPayload(SAMPLE_UPSTREAM);
  assert.equal(payload.count, 2); // junk dropped
  assert.equal(payload.withGeometry, 1);
  assert.equal(payload.alerts[0].event, 'Tornado Warning');
  assert.equal(payload.alerts[1].geometry, null);
  assert.deepEqual(payload.alerts[1].affectedZones, []);
});

test('handler serves trimmed snapshot with mocked fetch', async () => {
  const calls = mount(nwsAlertsProxy());
  const realFetch = globalThis.fetch;
  const body = JSON.stringify(SAMPLE_UPSTREAM);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/geo+json' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/nws-alerts'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2);
    assert.equal(payload.alerts[0].severity, 'Extreme');
    assert.match(res.headers['Cache-Control'], /max-age=300/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  _nwsAlertsInternals.clearCaches(); // avoid leaking the earlier test's 5-min cache
  const calls = mount(nwsAlertsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/nws-alerts'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /nws_alerts_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(nwsAlertsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/nws-alerts', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
