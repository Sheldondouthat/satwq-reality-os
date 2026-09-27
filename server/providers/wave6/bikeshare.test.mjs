import assert from 'node:assert/strict';
import test from 'node:test';
import { bikeshareProxy, _bikeshareInternals } from './bikeshare.js';

const { trimStation, parseGbfsSystem, buildSnapshot } = _bikeshareInternals;

// Real fixtures captured from live Citi Bike GBFS 2.3 feeds on 2026-09-27
// (gbfs.lyft.com/gbfs/2.3/bkn/en/station_status.json +
// station_information.json — both HTTP 200, no redirect).
const STATUS_FIXTURE = [
  {
    station_id: '2124036994734951288',
    num_bikes_available: 10,
    num_bikes_disabled: 1,
    num_docks_available: 1,
    num_docks_disabled: 0,
    is_installed: 1,
    is_renting: 1,
    is_returning: 1,
    last_reported: 1790543081,
    vehicle_types_available: [
      { vehicle_type_id: '1', count: 8 },
      { vehicle_type_id: '2', count: 2 },
    ],
    num_ebikes_available: 2,
    num_scooters_available: 0,
    num_scooters_unavailable: 0,
  },
  {
    station_id: '4c03fa2d-89da-4f0b-8f19-c7de5edbe256',
    num_bikes_available: 10,
    num_bikes_disabled: 2,
    num_docks_available: 13,
    num_docks_disabled: 0,
    is_installed: 1,
    is_renting: 1,
    is_returning: 1,
    last_reported: 1790543128,
    vehicle_types_available: [
      { vehicle_type_id: '1', count: 4 },
      { vehicle_type_id: '2', count: 6 },
    ],
    num_ebikes_available: 6,
    num_scooters_available: 0,
    num_scooters_unavailable: 0,
  },
  {
    station_id: '29a41b09-698f-43e2-82ff-f94f73e74841',
    num_bikes_available: 19,
    num_bikes_disabled: 0,
    num_docks_available: 0,
    num_docks_disabled: 0,
    is_installed: 1,
    is_renting: 1,
    is_returning: 1,
    last_reported: 1790543128,
    vehicle_types_available: [
      { vehicle_type_id: '1', count: 12 },
      { vehicle_type_id: '2', count: 7 },
    ],
    num_ebikes_available: 7,
    num_scooters_available: 0,
    num_scooters_unavailable: 0,
  },
];

const INFO_FIXTURE = [
  {
    station_id: '2124036994734951288',
    name: 'Shore Rd & 86 St',
    short_name: '2472.02',
    lon: -74.04079,
    lat: 40.62561,
    region_id: '71',
    capacity: 12,
    rental_uris: { android: 'https://bkn.lft.to/lastmile_qr_scan', ios: 'https://bkn.lft.to/lastmile_qr_scan' },
    is_charging: false,
  },
  {
    station_id: '4c03fa2d-89da-4f0b-8f19-c7de5edbe256',
    name: 'E 147 St & Bergen Ave',
    short_name: '7840.11',
    lon: -73.91839,
    lat: 40.814673,
    region_id: '71',
    capacity: 25,
    rental_uris: { android: 'https://bkn.lft.to/lastmile_qr_scan', ios: 'https://bkn.lft.to/lastmile_qr_scan' },
    is_charging: false,
  },
  {
    station_id: '29a41b09-698f-43e2-82ff-f94f73e74841',
    name: '41 St & 3 Ave',
    short_name: '3388.02',
    lon: -74.008906,
    lat: 40.652512,
    region_id: '71',
    capacity: 19,
    rental_uris: { android: 'https://bkn.lft.to/lastmile_qr_scan', ios: 'https://bkn.lft.to/lastmile_qr_scan' },
    is_charging: false,
  },
];

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

test('bikeshareProxy mounts /api/bikeshare on both server shapes', () => {
  const routes = mount(bikeshareProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/bikeshare', '/api/bikeshare']);
});

test('trimStation joins status + info into the normalized shape', () => {
  const statusById = new Map(STATUS_FIXTURE.map((s) => [s.station_id, s]));
  const t = trimStation('citibike', INFO_FIXTURE[0], statusById);
  assert.equal(t.id, 'citibike:2124036994734951288');
  assert.equal(t.system, 'citibike');
  assert.equal(t.name, 'Shore Rd & 86 St');
  assert.equal(t.lat, 40.62561);
  assert.equal(t.lon, -74.04079);
  assert.equal(t.bikes, 10);
  assert.equal(t.ebikes, 2);
  assert.equal(t.docks, 1);
  assert.equal(t.capacity, 12);
  assert.equal(t.installed, true);
  assert.equal(t.renting, true);
  assert.equal(t.returning, true);
  assert.equal(t.lastReported, '2026-09-27T21:04:41.000Z');
});

test('trimStation degrades gracefully when the status record is missing', () => {
  const t = trimStation('baywheels', INFO_FIXTURE[0], new Map());
  assert.equal(t.name, 'Shore Rd & 86 St');
  assert.equal(t.bikes, null);
  assert.equal(t.installed, null);
  assert.equal(t.lastReported, null);
});

test('trimStation drops records without id or valid coords', () => {
  const byId = new Map();
  assert.equal(trimStation('citibike', { station_id: '', lat: 40, lon: -74 }, byId), null);
  assert.equal(trimStation('citibike', { station_id: 'x', lat: 999, lon: -74 }, byId), null);
});

test('parseGbfsSystem sums availability and records feed freshness', () => {
  const system = { key: 'citibike', name: 'Citi Bike NYC', attribution: 'test' };
  const statusJson = { last_updated: 1790543081, data: { stations: STATUS_FIXTURE } };
  const infoJson = { last_updated: 1790543000, data: { stations: INFO_FIXTURE } };
  const parsed = parseGbfsSystem(system, statusJson, infoJson);
  assert.equal(parsed.stationCount, 3);
  assert.equal(parsed.bikesAvailable, 39); // 10 + 10 + 19
  assert.equal(parsed.docksAvailable, 14); // 1 + 13 + 0
  assert.equal(parsed.statusFeedUpdated, '2026-09-27T21:04:41.000Z');
  assert.equal(parsed.stations[0].ebikes, 2);
});

test('buildSnapshot merges systems with per-system metadata', () => {
  const r = buildSnapshot([
    {
      key: 'citibike', name: 'Citi Bike NYC', ok: true, stationCount: 1,
      bikesAvailable: 10, docksAvailable: 1, statusFeedUpdated: '2026-09-27T13:00:00.000Z',
      attribution: 'a', latencyMs: 5, stations: [{ id: 'citibike:1', system: 'citibike' }],
    },
    {
      key: 'baywheels', name: 'Bay Wheels SF', ok: false, stationCount: 0,
      bikesAvailable: 0, docksAvailable: 0, statusFeedUpdated: null,
      attribution: 'b', latencyMs: 9, error: 'bikeshare_baywheels_status_upstream_503',
      stations: [],
    },
  ]);
  assert.equal(r.count, 1);
  assert.equal(r.systems.citibike.ok, true);
  assert.equal(r.systems.citibike.bikesAvailable, 10);
  assert.equal(r.systems.baywheels.ok, false);
  assert.equal(r.systems.baywheels.error, 'bikeshare_baywheels_status_upstream_503');
});

test('handler serves trimmed snapshot with mocked fetch', async () => {
  _bikeshareInternals.clearCaches();
  const calls = mount(bikeshareProxy());
  const realFetch = globalThis.fetch;
  const statusJson = { last_updated: 1790543081, data: { stations: STATUS_FIXTURE } };
  const infoJson = { last_updated: 1790543000, data: { stations: INFO_FIXTURE } };
  globalThis.fetch = async (url) => new Response(
    JSON.stringify(String(url).includes('station_status') ? statusJson : infoJson),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/bikeshare'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 6); // 3 stations × 2 systems
    assert.equal(payload.systems.citibike.stationCount, 3);
    assert.equal(payload.systems.baywheels.stationCount, 3);
    assert.equal(payload.stations[0].system, 'baywheels'); // sorted by system
    assert.match(res.headers['Cache-Control'], /max-age=60/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when all systems are down', async () => {
  _bikeshareInternals.clearCaches();
  const calls = mount(bikeshareProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/bikeshare'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /bikeshare_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler still serves 200 when one system fails', async () => {
  _bikeshareInternals.clearCaches();
  const calls = mount(bikeshareProxy());
  const realFetch = globalThis.fetch;
  const statusJson = { last_updated: 1790543081, data: { stations: STATUS_FIXTURE } };
  const infoJson = { last_updated: 1790543000, data: { stations: INFO_FIXTURE } };
  globalThis.fetch = async (url) => String(url).includes('/bay/')
    ? new Response('down', { status: 503 })
    : new Response(JSON.stringify(String(url).includes('station_status') ? statusJson : infoJson), { status: 200 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/bikeshare'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 3);
    assert.equal(payload.systems.baywheels.ok, false);
    assert.match(payload.systems.baywheels.error, /upstream_503/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(bikeshareProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/bikeshare', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
