import assert from 'node:assert/strict';
import test from 'node:test';
import {
  aqiColor,
  aqiName,
  formatPm,
  hazeRadiusM,
  sensorLabel,
  summaryText,
} from './model.js';
import {
  aqiCategory,
  parseArea,
  parseSensorPayload,
  parseSensorRecord,
  sensorCommunityProxy,
} from '../../../../server/providers/wave3/sensorCommunity.js';

// — model.js —

test('aqiColor/aqiName cover the six EPA bands', () => {
  assert.equal(aqiColor(1), '#3ddc84');
  assert.equal(aqiColor(6), '#8b1a3d');
  assert.equal(aqiColor(0), '#8a93a6');
  assert.equal(aqiName(3), 'USG');
  assert.equal(aqiName(99), 'n/a');
});

test('hazeRadiusM grows with severity', () => {
  assert.ok(hazeRadiusM(6) > hazeRadiusM(1));
  assert.equal(hazeRadiusM(1), 1500);
});

test('formatPm and sensorLabel', () => {
  assert.equal(formatPm(12.345), '12.3 µg/m³');
  assert.equal(formatPm(Number.NaN), '—');
  const label = sensorLabel({ id: '7', pm25: 40, pm10: 55, aqi: 3 });
  assert.match(label, /PM2\.5 40\.0/);
  assert.match(label, /USG \(est\.\)/);
});

test('summaryText handles empty and populated summaries', () => {
  assert.equal(summaryText({ withPm25: 0 }), 'no PM2.5 sensors in view');
  assert.match(
    summaryText({ count: 10, withPm25: 8, avgPm25: 11.08, maxPm25: 40, worstAqi: 3 }),
    /10 sensors · avg PM2\.5 11\.1 µg\/m³ · worst USG \(est\.\)/,
  );
});

// — provider parsing —

test('aqiCategory follows US EPA PM2.5 breakpoints', () => {
  assert.equal(aqiCategory(5), 1);
  assert.equal(aqiCategory(12.0), 1);
  assert.equal(aqiCategory(12.1), 2);
  assert.equal(aqiCategory(40), 3);
  assert.equal(aqiCategory(100), 4);
  assert.equal(aqiCategory(200), 5);
  assert.equal(aqiCategory(300), 6);
  assert.equal(aqiCategory(-1), null);
});

test('parseArea validates lat/lon/radius', () => {
  const q = (o) => new URLSearchParams(o);
  assert.deepEqual(parseArea(q({ lat: '51.05', lon: '3.72', r: '10' })), { lat: 51.05, lon: 3.72, r: 10 });
  assert.deepEqual(parseArea(q({ lat: '51.05', lon: '3.72' })), { lat: 51.05, lon: 3.72, r: 10 });
  assert.throws(() => parseArea(q({ lat: '91', lon: '3.72' })), /air_bad_lat/);
  assert.throws(() => parseArea(q({ lat: '51', lon: 'x' })), /air_bad_lon/);
  assert.throws(() => parseArea(q({ lat: '51', lon: '3', r: '100' })), /air_bad_radius/);
});

const SENSOR_FIXTURE = [
  {
    sampling_rate: null,
    timestamp: '2026-09-27 05:53:00',
    sensordatavalues: [
      { value_type: 'temperature', value: '11.08' },
      { value_type: 'P1', value: '18.20' },
      { value_type: 'P2', value: '40.00' },
    ],
    sensor: { sensor_type: { manufacturer: 'Plantower', name: 'PMS5003', id: 19 }, pin: '1', id: 95187 },
    location: { indoor: 0, longitude: '3.59198920000', latitude: '50.95783740000', country: 'BE' },
  },
  {
    // indoor sensor: parsed but excluded from the haze field
    timestamp: '2026-09-27 05:53:00',
    sensordatavalues: [{ value_type: 'P2', value: '5.0' }],
    sensor: { id: 111 },
    location: { indoor: 1, longitude: '3.6', latitude: '50.96' },
  },
  {
    // temperature-only node: no PM at all -> dropped
    timestamp: '2026-09-27 05:53:00',
    sensordatavalues: [{ value_type: 'temperature', value: '11.08' }],
    sensor: { id: 222 },
    location: { indoor: 0, longitude: '3.61', latitude: '50.97' },
  },
];

test('parseSensorRecord extracts PM + AQI estimate', () => {
  const s = parseSensorRecord(SENSOR_FIXTURE[0]);
  assert.equal(s.id, '95187');
  assert.ok(Math.abs(s.lat - 50.9578) < 1e-4);
  assert.equal(s.pm25, 40);
  assert.equal(s.pm10, 18.2);
  assert.equal(s.aqi, 3);
  assert.equal(s.indoor, false);
  assert.ok(Number.isFinite(s.timeMs));
});

test('parseSensorPayload drops indoor and PM-less records', () => {
  const { sensors, summary } = parseSensorPayload(JSON.stringify(SENSOR_FIXTURE));
  assert.equal(sensors.length, 1);
  assert.equal(summary.count, 1);
  assert.equal(summary.withPm25, 1);
  assert.equal(summary.avgPm25, 40);
  assert.equal(summary.worstAqi, 3);
});

test('parseSensorPayload throws 502 on truncated upstream JSON', () => {
  assert.throws(
    () => parseSensorPayload('[{"sampling_rate":null,"timest'),
    (e) => e.status === 502 && /truncated/.test(e.message),
  );
});

// — provider HTTP behavior —

function fakeReq(url, method = 'GET') {
  return { method, url, headers: {}, on: () => {}, removeListener: () => {} };
}
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
function fakeFetchText(text) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      body: { cancel: async () => {} },
      text: async () => text,
    };
  };
  return { fetchImpl, calls };
}
async function callHandler(proxy, url, method = 'GET') {
  const seen = [];
  proxy.configureServer({ middlewares: { use: (route, handler) => seen.push({ route, handler }) } });
  const req = fakeReq(url, method);
  const res = fakeRes();
  await seen[0].handler(req, res);
  return res;
}

test('sensorCommunityProxy mounts /api/air-quality on both server shapes', () => {
  const proxy = sensorCommunityProxy();
  assert.equal(proxy.name, 'sensor-community');
  const seen = [];
  proxy.configureServer({ middlewares: { use: (r) => seen.push(r) } });
  proxy.configurePreviewServer({ middlewares: { use: (r) => seen.push(r) } });
  assert.deepEqual(seen, ['/api/air-quality', '/api/air-quality']);
});

test('sensorCommunityProxy rejects POST and bad area', async () => {
  const post = await callHandler(sensorCommunityProxy(), '/api/air-quality?lat=51&lon=3', 'POST');
  assert.equal(post.statusCode, 405);
  const bad = await callHandler(sensorCommunityProxy(), '/api/air-quality?lat=999&lon=3');
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /air_bad_lat/);
});

test('sensorCommunityProxy serves sensors + summary and caches', async () => {
  const { fetchImpl, calls } = fakeFetchText(JSON.stringify(SENSOR_FIXTURE));
  const proxy = sensorCommunityProxy({ fetchImpl, now: () => 3_000_000 });
  const url = '/api/air-quality?lat=51.05&lon=3.72&r=10';
  const first = await callHandler(proxy, url);
  assert.equal(first.statusCode, 200);
  const doc = JSON.parse(first.body);
  assert.equal(doc.summary.count, 1);
  assert.ok(doc.aqiModel.includes('estimate'));
  assert.match(calls[0], /data\.sensor\.community\/airrohr\/v1\/filter\/area=51\.05,3\.72,10/);
  const second = await callHandler(proxy, url);
  assert.equal(second.statusCode, 200);
  assert.equal(calls.length, 1);
});

test('sensorCommunityProxy returns 502 with hint on truncated upstream', async () => {
  const { fetchImpl } = fakeFetchText('[{"sampling_rate":null,"truncated');
  const proxy = sensorCommunityProxy({ fetchImpl, now: () => 3_000_000 });
  const res = await callHandler(proxy, '/api/air-quality?lat=51.05&lon=3.72&r=10');
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /reduce r/);
});
