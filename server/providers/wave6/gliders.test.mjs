import assert from 'node:assert/strict';
import test from 'node:test';
import { glidersProxy, _glidersInternals } from './gliders.js';

const { parseOgnMarkers, trimGlidersPayload, clearCaches } = _glidersInternals;

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
  return { method, url: '/api/gliders', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('glidersProxy mounts /api/gliders on both server shapes', () => {
  const routes = mount(glidersProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/gliders', '/api/gliders']);
});

const OGN_FIXTURE = `<markers>
<m id="FLR123456" lat="50.1109" lng="8.6821" a="350" c="180" s="95" reg="D-4711" cn="A1" t="glider"/>
<m id="FLR999999" lat="91.0" lng="8.0" a="100"/>
<m id="FLR000000" lat="" lng="" a="100"/>
<marker id="not-an-m-tag" lat="48.0" lng="11.0"/>
</markers>`;

test('parseOgnMarkers parses valid markers and drops bad ones', () => {
  const markers = parseOgnMarkers(OGN_FIXTURE);
  assert.equal(markers.length, 1, 'out-of-range lat and empty coords must be dropped; <marker> is not <m>');
  const m = markers[0];
  assert.equal(m.id, 'FLR123456');
  assert.equal(m.lat, 50.1109);
  assert.equal(m.lon, 8.6821);
  assert.equal(m.altM, 350);
  assert.equal(m.heading, 180);
  assert.equal(m.speedKmh, 95);
  assert.equal(m.reg, 'D-4711');
  assert.equal(m.cn, 'A1');
  assert.equal(m.type, 'glider');
});

test('parseOgnMarkers tolerates lon/longitude aliases', () => {
  const markers = parseOgnMarkers('<markers><m flarm="ABCDEF" latitude="46.5" longitude="7.1"/></markers>');
  assert.equal(markers.length, 1);
  assert.equal(markers[0].id, 'ABCDEF');
  assert.equal(markers[0].lat, 46.5);
  assert.equal(markers[0].lon, 7.1);
  assert.equal(markers[0].altM, null);
});

test('trimGlidersPayload wraps markers with metadata', () => {
  const payload = trimGlidersPayload(OGN_FIXTURE);
  assert.equal(payload.count, 1);
  assert.equal(payload.capped, false);
  assert.ok(Date.parse(payload.generatedAt) > 0);
});

test('handler returns 502 JSON when the upstream is down', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const [{ handler }] = mount(glidersProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'gliders_unavailable');
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
    return new Response(OGN_FIXTURE, { status: 200, headers: { 'Content-Type': 'application/xml' } });
  };
  try {
    const [{ handler }] = mount(glidersProxy());
    const res1 = fakeRes();
    await handler(fakeReq('GET'), res1);
    assert.equal(res1.statusCode, 200);
    assert.equal(JSON.parse(res1.body).count, 1);
    const res2 = fakeRes();
    await handler(fakeReq('GET'), res2);
    assert.equal(fetchCalls, 1, 'second request must come from the TTL cache');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
