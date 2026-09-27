import assert from 'node:assert/strict';
import test from 'node:test';
import { satnogsProxy, _satnogsInternals } from './satnogs.js';

const { trimTleRow, trimStation, trimTransmitter, buildPayload } = _satnogsInternals;

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

const SAMPLE_TLE = [
  {
    tle0: '0 ISS (ZARYA)',
    tle1: '1 25544U 98067A   26270.17419514  .00009528  00000-0  18291-3 0  9997',
    tle2: '2 25544  51.6315 155.3455 0007168 193.0560 167.0244 15.48664528587561',
    tle_source: 'Space-Track.org',
    sat_id: 'XSKZ-5603-1870-9019-3066',
    norad_cat_id: 25544,
    updated: '2026-09-27T11:22:51.845520Z',
  },
  { norad_cat_id: null, tle1: '', tle2: '' }, // junk
];

const SAMPLE_STATIONS = [
  {
    id: 1,
    name: 'Hackerspace.gr 1',
    lat: 38.01697,
    lng: 23.7314,
    qthlocator: 'KM18ua',
    observations: 10624,
    future_observations: 0,
    last_seen: '2022-10-05T12:49:26Z',
    antenna: [
      { frequency: 400000000, frequency_max: 460000000, band: 'UHF', antenna_type_name: 'Cross Yagi' },
    ],
  },
  { id: 2, name: 'No Coords', lat: null, lng: null }, // junk: no coords
];

const SAMPLE_TRANSMITTERS = [
  {
    uuid: 'UzPz4gcsNBPKPKAFPmer7g',
    description: 'Upper side band (drifting)',
    alive: true,
    mode: 'USB',
    service: 'Unknown',
    status: 'active',
    uplink_low: null,
    uplink_high: null,
    downlink_low: 136658500,
    downlink_high: 136658500,
    norad_cat_id: 965,
    updated: '2019-04-18T05:39:53.343316Z',
  },
  {
    uuid: 'dead-one',
    description: 'retired',
    alive: false,
    mode: 'FM',
    status: 'inactive',
    uplink_low: 145900000,
    uplink_high: 145900000,
    downlink_low: 437100000,
    downlink_high: 437100000,
    norad_cat_id: 25544,
  },
];

test('satnogsProxy mounts /api/satnogs on both server shapes', () => {
  const routes = mount(satnogsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/satnogs', '/api/satnogs']);
});

test('trimTleRow strips the 0 prefix and keeps TLE lines', () => {
  const r = trimTleRow(SAMPLE_TLE[0]);
  assert.equal(r.name, 'ISS (ZARYA)');
  assert.equal(r.noradCatId, 25544);
  assert.ok(r.line1.startsWith('1 25544'));
  assert.equal(r.tleSource, 'Space-Track.org');
});

test('trimStation rounds coords and derives observed status', () => {
  const s = trimStation(SAMPLE_STATIONS[0]);
  assert.equal(s.lat, 38.01697);
  assert.equal(s.lng, 23.7314);
  assert.equal(s.status, 'observed');
  assert.equal(s.antennas.length, 1);
  assert.equal(s.antennas[0].frequencyLowHz, 400000000);
  assert.equal(s.antennas[0].band, 'UHF');
});

test('trimStation marks never-seen stations idle', () => {
  assert.equal(trimStation({ id: 9, lat: 1, lng: 2, observations: 0, future_observations: 0 }).status, 'idle');
  assert.equal(trimStation({ id: 9, lat: 1, lng: 2, observations: 0, future_observations: 3 }).status, 'scheduled');
});

test('trimTransmitter keeps freq pairs and drops dead ones in buildPayload', () => {
  const t = trimTransmitter(SAMPLE_TRANSMITTERS[0]);
  assert.equal(t.downlinkHz.low, 136658500);
  assert.equal(t.uplinkHz.low, null);
  assert.equal(t.alive, true);
  const payload = buildPayload('transmitters', SAMPLE_TRANSMITTERS);
  assert.equal(payload.count, 1); // dead one filtered
  assert.equal(payload.transmitters[0].uuid, 'UzPz4gcsNBPKPKAFPmer7g');
});

test('buildPayload tle drops junk rows', () => {
  const payload = buildPayload('tle', SAMPLE_TLE);
  assert.equal(payload.count, 1);
  assert.ok(payload.honesty.includes('Complements /api/celestrak'));
});

test('buildPayload stations drops coord-less rows', () => {
  const payload = buildPayload('stations', SAMPLE_STATIONS);
  assert.equal(payload.count, 1);
  assert.equal(payload.withAntennas, 1);
  assert.ok(payload.honesty.includes('declared capability'));
});

test('handler serves ?dataset=stations with mocked fetch', async () => {
  const calls = mount(satnogsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(SAMPLE_STATIONS), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/satnogs?dataset=stations'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 1);
    assert.equal(payload.stations[0].name, 'Hackerspace.gr 1');
    assert.equal(payload.limitedTo, 1);
  } finally {
    globalThis.fetch = realFetch;
    _satnogsInternals.clearCaches();
  }
});

test('handler applies ?limit= to tle rows', async () => {
  const calls = mount(satnogsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(SAMPLE_TLE.concat(SAMPLE_TLE)), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/satnogs?dataset=tle&limit=1'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.rows.length, 1);
    assert.equal(payload.limitedTo, 1);
    assert.equal(payload.count, 2); // total before limiting
  } finally {
    globalThis.fetch = realFetch;
    _satnogsInternals.clearCaches();
  }
});

test('handler returns 400 usage for unknown dataset', async () => {
  const calls = mount(satnogsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/satnogs?dataset=nope'), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /tle\|stations\|transmitters/);
});

test('handler returns 400 usage with no dataset', async () => {
  const calls = mount(satnogsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/satnogs'), res);
  assert.equal(res.statusCode, 400);
});

test('handler returns 502 JSON when upstream is down', async () => {
  _satnogsInternals.clearCaches();
  const calls = mount(satnogsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 500 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/satnogs?dataset=tle'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /satnogs_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(satnogsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/satnogs', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
