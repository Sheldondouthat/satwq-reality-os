import assert from 'node:assert/strict';
import test from 'node:test';
import { mbtaProxy, _mbtaInternals } from './mbta.js';

const {
  parseVehicles,
  normalizeVehicle,
  routeNameIndex,
  validateRouteParam,
  buildUpstreamUrl,
} = _mbtaInternals;

// Fixtures follow the MBTA v3 JSON:API shape (documented), not live
// captures — api-v3.mbta.com returned curl 000 from the build VM on
// 2026-09-27 (VM-throttled, needs Worker probe).
const MBTA_FIXTURE = {
  data: [
    {
      id: 'y1621-38',
      type: 'vehicle',
      attributes: {
        bearing: 90,
        current_status: 'IN_TRANSIT_TO',
        current_stop_sequence: 12,
        direction_id: 0,
        label: '1621',
        latitude: 42.3601,
        longitude: -71.0589,
        occupancy_status: 'MANY_SEATS_AVAILABLE',
        speed: 8.5,
        updated_at: '2026-09-27T17:30:00-04:00',
      },
      relationships: {
        route: { data: { id: 'Red', type: 'route' } },
        stop: { data: { id: 'place-pktrm', type: 'stop' } },
        trip: { data: { id: 'canonical-Red-C1-12', type: 'trip' } },
      },
    },
    {
      id: 'y0900-12',
      type: 'vehicle',
      attributes: {
        bearing: 270,
        current_status: 'STOPPED_AT',
        current_stop_sequence: 3,
        direction_id: 1,
        label: '900',
        latitude: 42.355,
        longitude: -71.0655,
        occupancy_status: null,
        speed: null,
        updated_at: '2026-09-27T17:31:00-04:00',
      },
      relationships: {
        route: { data: { id: 'Green-B', type: 'route' } },
        stop: { data: { id: 'place-boscl', type: 'stop' } },
        trip: { data: { id: 'canonical-Green-B-3', type: 'trip' } },
      },
    },
    // No coordinates — must be dropped.
    {
      id: 'ghost-1',
      type: 'vehicle',
      attributes: { latitude: null, longitude: null, current_status: 'IN_TRANSIT_TO' },
      relationships: {},
    },
  ],
  included: [
    {
      id: 'Red',
      type: 'route',
      attributes: { long_name: 'Red Line', short_name: '', type: 1, color: 'DA291C' },
    },
    {
      id: 'Green-B',
      type: 'route',
      attributes: { long_name: '', short_name: 'B', type: 0, color: '00843D' },
    },
  ],
  jsonapi: { version: '1.0' },
};

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

test('mbtaProxy mounts /api/mbta on both server shapes', () => {
  const routes = mount(mbtaProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/mbta', '/api/mbta']);
});

test('routeNameIndex prefers long_name, falls back to short_name then id', () => {
  const idx = routeNameIndex(MBTA_FIXTURE.included);
  assert.equal(idx.get('Red'), 'Red Line');
  assert.equal(idx.get('Green-B'), 'B');
  assert.equal(routeNameIndex([{ id: 'X', type: 'route', attributes: {} }]).get('X'), 'X');
});

test('normalizeVehicle maps status enum and parses updated_at with offset', () => {
  const idx = routeNameIndex(MBTA_FIXTURE.included);
  const v = normalizeVehicle(MBTA_FIXTURE.data[0], idx);
  assert.equal(v.id, 'y1621-38');
  assert.equal(v.lat, 42.3601);
  assert.equal(v.lon, -71.0589);
  assert.equal(v.bearing, 90);
  assert.equal(v.label, '1621');
  assert.equal(v.status, 'In transit');
  assert.equal(v.routeId, 'Red');
  assert.equal(v.routeName, 'Red Line');
  assert.equal(v.tripId, 'canonical-Red-C1-12');
  assert.equal(v.stopId, 'place-pktrm');
  assert.equal(v.speedMps, 8.5);
  assert.equal(v.updatedAt, '2026-09-27T21:30:00.000Z');
  const stopped = normalizeVehicle(MBTA_FIXTURE.data[1], idx);
  assert.equal(stopped.status, 'Stopped');
  assert.equal(stopped.routeName, 'B');
});

test('normalizeVehicle drops records without coordinates', () => {
  const v = normalizeVehicle(MBTA_FIXTURE.data[2], new Map());
  assert.equal(v, null);
});

test('parseVehicles drops coordless records and sorts by route name', () => {
  const vehicles = parseVehicles(MBTA_FIXTURE);
  assert.equal(vehicles.length, 2);
  assert.equal(vehicles[0].routeName, 'B'); // 'B' < 'Red Line'
  assert.equal(vehicles[1].routeName, 'Red Line');
});

test('validateRouteParam accepts ids, rejects injection', () => {
  const q = (s) => new URLSearchParams(s);
  assert.equal(validateRouteParam(q('route=Red')), 'Red');
  assert.equal(validateRouteParam(q('route=Green-B')), 'Green-B');
  assert.equal(validateRouteParam(q('')), null);
  assert.throws(() => validateRouteParam(q('route=Red%20Line')), /mbta_bad_route_param/);
  assert.throws(() => validateRouteParam(q('route=../../etc')), /mbta_bad_route_param/);
});

test('buildUpstreamUrl always includes route include, filters when asked', () => {
  const plain = buildUpstreamUrl(null);
  assert.match(plain, /include=route/);
  assert.doesNotMatch(plain, /filter/);
  const filtered = buildUpstreamUrl('Red');
  assert.match(filtered, /filter%5Broute%5D=Red/);
});

test('handler serves normalized snapshot with mocked fetch', async () => {
  _mbtaInternals.clearCaches();
  const calls = mount(mbtaProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/api-v3\.mbta\.com\/vehicles/);
    return new Response(JSON.stringify(MBTA_FIXTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.api+json' },
    });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/mbta'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 2);
    assert.equal(payload.model, false);
    assert.equal(payload.observation, true);
    assert.equal(payload.vehicles[0].routeName, 'B');
    assert.ok(payload.attribution.includes('MBTA'));
    assert.match(res.headers['Cache-Control'], /max-age=30/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler forwards ?route= to the upstream URL', async () => {
  _mbtaInternals.clearCaches();
  const calls = mount(mbtaProxy());
  const realFetch = globalThis.fetch;
  let seenUrl = '';
  globalThis.fetch = async (url) => {
    seenUrl = String(url);
    return new Response(JSON.stringify({ data: [], included: [] }), { status: 200 });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/mbta?route=Red'), res);
    assert.equal(res.statusCode, 200);
    assert.match(seenUrl, /filter%5Broute%5D=Red/);
    assert.equal(JSON.parse(res.body).route, 'Red');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when the upstream is down', async () => {
  _mbtaInternals.clearCaches();
  const calls = mount(mbtaProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/mbta'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /mbta_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects bad route param with 400 and non-GET with 405', async () => {
  const calls = mount(mbtaProxy());
  const bad = fakeRes();
  await calls[0].handler(fakeReq('/api/mbta?route=../x'), bad);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /mbta_bad_route_param/);
  const post = fakeRes();
  await calls[0].handler(fakeReq('/api/mbta', 'POST'), post);
  assert.equal(post.statusCode, 405);
});
