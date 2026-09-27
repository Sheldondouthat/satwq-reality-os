/**
 * sensor.community provider tests — original area-API behavior plus the
 * wave-7 static-snapshot extension (#136). All network is mocked via
 * fetchImpl injection; the static dump fixture follows the sensor.community
 * v2 record schema (docs; VM could not probe the static host — curl 000 on
 * 2026-09-27 — so "needs Worker probe" for schema confirmation).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  sensorCommunityProxy,
  parseSourceMode,
  haversineKm,
  filterToArea,
  summarizeSensors,
  parseStaticPayload,
  parseSensorPayload,
} from './sensorCommunity.js';

// Near sensor (Pembroke VA), far sensor (Philadelphia), indoor sensor (dropped).
const STATIC_FIXTURE = [
  {
    sensor: { id: 1001, sensor_type: { name: 'SDS011' } },
    location: { latitude: '37.2673', longitude: '-80.7266', indoor: 0 },
    sensordatavalues: [
      { value_type: 'P1', value: '10.5' },
      { value_type: 'P2', value: '6.2' },
    ],
    timestamp: '2026-09-27 21:00:00',
  },
  {
    sensor: { id: 1002, sensor_type: { name: 'SDS011' } },
    location: { latitude: '39.9526', longitude: '-75.1652', indoor: 0 },
    sensordatavalues: [
      { value_type: 'P1', value: '30.0' },
      { value_type: 'P2', value: '18.0' },
    ],
    timestamp: '2026-09-27 21:00:00',
  },
  {
    sensor: { id: 1003, sensor_type: { name: 'SDS011' } },
    location: { latitude: '37.2674', longitude: '-80.7267', indoor: 1 },
    sensordatavalues: [
      { value_type: 'P1', value: '99.0' },
      { value_type: 'P2', value: '60.0' },
    ],
    timestamp: '2026-09-27 21:00:00',
  },
];

const AREA_FIXTURE = [STATIC_FIXTURE[0]];

function textResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    headers: new Map(),
    body: { cancel: async () => {} },
    text: async () => JSON.stringify(payload),
  };
}

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
    once() {},
    removeListener() {},
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

test('parseSourceMode defaults to auto, accepts the three modes, rejects junk', () => {
  assert.equal(parseSourceMode(new URLSearchParams('')), 'auto');
  assert.equal(parseSourceMode(new URLSearchParams('source=static')), 'static');
  assert.equal(parseSourceMode(new URLSearchParams('source=AREA')), 'area');
  assert.throws(() => parseSourceMode(new URLSearchParams('source=everything')), /air_bad_source/);
});

test('haversineKm is sane', () => {
  assert.equal(haversineKm(0, 0, 0, 0), 0);
  const oneDegree = haversineKm(0, 0, 1, 0);
  assert.ok(Math.abs(oneDegree - 111.19) < 0.1, `got ${oneDegree}`);
  assert.equal(haversineKm(37, -80, 38, -80), haversineKm(38, -80, 37, -80));
});

test('filterToArea keeps near sensors and drops far ones', () => {
  const sensors = [
    { id: 'near', lat: 37.2673, lon: -80.7266 },
    { id: 'far', lat: 39.9526, lon: -75.1652 },
  ];
  const kept = filterToArea(sensors, { lat: 37.2673, lon: -80.7266, r: 10 });
  assert.deepEqual(kept.map((s) => s.id), ['near']);
});

test('summarizeSensors aggregates pm2.5', () => {
  const summary = summarizeSensors([
    { pm25: 6.2, aqi: 1 },
    { pm25: 18.0, aqi: 2 },
    { pm25: null, aqi: null },
  ]);
  assert.equal(summary.count, 3);
  assert.equal(summary.withPm25, 2);
  assert.equal(summary.avgPm25, 12.1);
  assert.equal(summary.maxPm25, 18.0);
  assert.equal(summary.worstAqi, 2);
});

test('parseStaticPayload maps records, drops indoor, throws 502 on truncation', () => {
  const sensors = parseStaticPayload(JSON.stringify(STATIC_FIXTURE));
  assert.equal(sensors.length, 2); // indoor sensor dropped
  assert.equal(sensors[0].pm25, 6.2);
  assert.equal(sensors[0].pm10, 10.5);
  assert.equal(sensors[1].pm25, 18.0);
  assert.throws(() => parseStaticPayload('{"truncated": tru'), (e) => e.status === 502 && /air_static_truncated/.test(e.message));
  assert.throws(() => parseStaticPayload('{"not":"array"}'), (e) => e.status === 502);
});

test('parseSensorPayload original behavior is unchanged', () => {
  const { sensors, summary } = parseSensorPayload(JSON.stringify(AREA_FIXTURE));
  assert.equal(sensors.length, 1);
  assert.equal(summary.count, 1);
  assert.equal(summary.avgPm25, 6.2);
});

test('handler area mode still serves via:"area"', async () => {
  const fetchImpl = async (url) => {
    assert.ok(String(url).includes('airrohr'), `unexpected url ${url}`);
    return textResponse(AREA_FIXTURE);
  };
  const calls = mount(sensorCommunityProxy({ fetchImpl, now: () => 1_000_000 }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/air-quality?lat=37.2673&lon=-80.7266&r=10'), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.via, 'area');
  assert.equal(payload.sensors.length, 1);
  assert.equal(payload.summary.avgPm25, 6.2);
});

test('handler auto mode falls back to the static snapshot when the area API fails', async () => {
  const fetchImpl = async (url) => {
    if (String(url).includes('static/v2')) return textResponse(STATIC_FIXTURE);
    throw new Error('airrohr unreachable');
  };
  const calls = mount(sensorCommunityProxy({ fetchImpl, now: () => 1_000_000 }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/air-quality?lat=37.2673&lon=-80.7266&r=10'), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.via, 'static');
  // Only the near sensor survives the 10 km haversine cut (Philadelphia is ~600 km away).
  assert.equal(payload.sensors.length, 1);
  assert.equal(payload.sensors[0].id, '1001');
  assert.equal(payload.summary.count, 1);
});

test('handler explicit static mode serves area-filtered snapshot', async () => {
  const fetchImpl = async (url) => {
    assert.ok(String(url).includes('static/v2'), `unexpected url ${url}`);
    return textResponse(STATIC_FIXTURE);
  };
  const calls = mount(sensorCommunityProxy({ fetchImpl, now: () => 1_000_000 }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/air-quality?lat=37.2673&lon=-80.7266&r=10&source=static'), res);
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.via, 'static');
  assert.equal(payload.sensors.length, 1);
});

test('handler explicit static mode 502s honestly when the snapshot fails', async () => {
  const fetchImpl = async () => textResponse({}, { ok: false, status: 503 });
  const calls = mount(sensorCommunityProxy({ fetchImpl, now: () => 1_000_000 }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/air-quality?lat=37.2673&lon=-80.7266&r=10&source=static'), res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /air_static_http_503/);
});

test('handler rejects a bad source param with 400', async () => {
  const calls = mount(sensorCommunityProxy({ fetchImpl: async () => textResponse([]) }));
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/air-quality?lat=37&lon=-80&source=everything'), res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /air_bad_source/);
});
