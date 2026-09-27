import assert from 'node:assert/strict';
import test from 'node:test';
import { uvProxy, _uvInternals } from './uv.js';

const { parseLatLon, openMeteoUrl, trimUvPayload, clearCaches } = _uvInternals;

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

function fakeReq(url = '/api/uv', method = 'GET') {
  return { method, url, originalUrl: url, on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const SAMPLE_UPSTREAM = {
  latitude: 37.27,
  longitude: -80.73,
  current_units: { uv_index: '' },
  current: { time: '2026-09-27T15:30', temperature_2m: 20.1, uv_index: 4.15, is_day: 1 },
  daily: {
    time: ['2026-09-27'],
    sunrise: ['2026-09-27T07:15'],
    sunset: ['2026-09-27T19:12'],
    uv_index_max: [6.8],
  },
};

test('uvProxy mounts /api/uv on both server shapes', () => {
  const routes = mount(uvProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/uv', '/api/uv']);
});

test('parseLatLon defaults, clamps, and rounds', () => {
  assert.deepEqual(parseLatLon({}), { latitude: 37.27, longitude: -80.73 });
  assert.deepEqual(parseLatLon({ latitude: '40.71277', longitude: '-74.00597' }), {
    latitude: 40.71,
    longitude: -74.01,
  });
  assert.deepEqual(parseLatLon({ latitude: '999', longitude: '-999' }), {
    latitude: 90,
    longitude: -180,
  });
  assert.deepEqual(parseLatLon({ latitude: 'garbage' }), { latitude: 37.27, longitude: -80.73 });
});

test('openMeteoUrl carries the required params', () => {
  const url = openMeteoUrl({ latitude: 37.27, longitude: -80.73 });
  assert.match(url, /^https:\/\/api\.open-meteo\.com\/v1\/forecast\?/);
  assert.match(url, /current=temperature_2m,uv_index,is_day/);
  assert.match(url, /daily=sunrise,sunset,uv_index_max/);
});

test('trimUvPayload extracts current + today fields', () => {
  const p = trimUvPayload(SAMPLE_UPSTREAM, { latitude: 37.27, longitude: -80.73 });
  assert.equal(p.value, 4.15);
  assert.equal(p.uvIndex, 4.15);
  assert.equal(p.unit, 'UV index');
  assert.equal(p.current.isDay, true);
  assert.equal(p.current.temperatureC, 20.1);
  assert.equal(p.today.date, '2026-09-27');
  assert.equal(p.today.uvIndexMax, 6.8);
  assert.equal(p.today.sunrise, '2026-09-27T07:15');
  assert.match(p.attribution, /CC-BY 4\.0/);
});

test('trimUvPayload throws 502 on bad upstream shape', () => {
  assert.throws(() => trimUvPayload(null, { latitude: 0, longitude: 0 }), /uv_upstream_shape/);
});

test('handler serves trimmed payload with mocked fetch', async () => {
  const calls = mount(uvProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(SAMPLE_UPSTREAM), { status: 200 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/uv?latitude=37.2673&longitude=-80.7266'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.uvIndex, 4.15);
    assert.equal(payload.today.uvIndexMax, 6.8);
    assert.match(res.headers['Cache-Control'], /max-age=1800/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  clearCaches();
  const calls = mount(uvProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/uv'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /uv_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(uvProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/uv', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
