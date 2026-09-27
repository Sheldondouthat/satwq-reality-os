import assert from 'node:assert/strict';
import test from 'node:test';
import { ripestatProxy, _ripestatInternals } from './ripestat.js';

const { parseCountryResources, parseAsnNeighbours, parseBgpState } = _ripestatInternals;

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

const SAMPLE_COUNTRY = {
  status: 'ok',
  data: { resources: { ipv4: ['1.2.3.0/24', '5.6.7.0/24'], ipv6: ['2001:db8::/32'], asn: ['15169', '13335'] } },
};

const SAMPLE_NEIGHBOURS = {
  status: 'ok',
  data: {
    neighbours: [
      { asn: 3356, type: 'left', power: 900, v4_peers: 120, v6_peers: 80 },
      { asn: 1299, type: 'right', power: 850, v4_peers: 90, v6_peers: 60 },
      { asn: 2914, type: 'left', power: 700, v4_peers: 50, v6_peers: 20 },
    ],
  },
};

const SAMPLE_BGP = {
  status: 'ok',
  data: {
    bgp_state: [
      { target_prefix: '1.1.1.0/24', path: [13335, 15169], source_id: 'rrc00', community: '', last_seen: '2026-09-27T16:00:00Z' },
      { target_prefix: '1.1.1.0/24', path: [3356, 15169], source_id: 'rrc01', community: '', last_seen: '2026-09-27T16:01:00Z' },
    ],
  },
};

test('ripestatProxy mounts /api/ripestat on both server shapes', () => {
  const routes = mount(ripestatProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/ripestat', '/api/ripestat']);
});

test('parseCountryResources counts prefixes and ASNs', () => {
  const r = parseCountryResources(SAMPLE_COUNTRY);
  assert.equal(r.ipv4Prefixes, 2);
  assert.equal(r.ipv6Prefixes, 1);
  assert.equal(r.asns, 2);
  assert.deepEqual(r.sampleIpv4, ['1.2.3.0/24', '5.6.7.0/24']);
});

test('parseCountryResources tolerates missing data', () => {
  const r = parseCountryResources({});
  assert.equal(r.ipv4Prefixes, 0);
  assert.equal(r.asns, 0);
});

test('parseAsnNeighbours counts by type and sorts by power', () => {
  const r = parseAsnNeighbours(SAMPLE_NEIGHBOURS);
  assert.equal(r.neighbourCount, 3);
  assert.equal(r.counts.left, 2);
  assert.equal(r.counts.right, 1);
  assert.equal(r.top[0].asn, 3356);
  assert.equal(r.top[0].power, 900);
  assert.equal(r.top[2].asn, 2914);
});

test('parseBgpState extracts origin ASNs and avg path length', () => {
  const r = parseBgpState(SAMPLE_BGP);
  assert.equal(r.routeCount, 2);
  assert.deepEqual(r.distinctOrigins, [15169]);
  assert.equal(r.avgPathLength, 2);
  assert.equal(r.routes[0].targetPrefix, '1.1.1.0/24');
});

test('handler serves country snapshot with mocked fetch', async () => {
  _ripestatInternals.clearCaches();
  const calls = mount(ripestatProxy());
  const realFetch = globalThis.fetch;
  const body = JSON.stringify(SAMPLE_COUNTRY);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/ripestat?country=US'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.mode, 'country');
    assert.equal(payload.country, 'US');
    assert.equal(payload.resources.asns, 2);
    assert.match(payload.attribution, /RIPE NCC/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler serves asn-neighbour snapshot with mocked fetch', async () => {
  _ripestatInternals.clearCaches();
  const calls = mount(ripestatProxy());
  const realFetch = globalThis.fetch;
  const body = JSON.stringify(SAMPLE_NEIGHBOURS);
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/ripestat?asn=15169'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.mode, 'asn');
    assert.equal(payload.asn, 15169);
    assert.equal(payload.neighbours.neighbourCount, 3);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  _ripestatInternals.clearCaches();
  const calls = mount(ripestatProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/ripestat'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /ripestat_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(ripestatProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/ripestat', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
