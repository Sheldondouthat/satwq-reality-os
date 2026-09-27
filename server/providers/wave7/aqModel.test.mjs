import assert from 'node:assert/strict';
import test from 'node:test';
import { aqModelProxy, _aqModelInternals } from './aqModel.js';

const { parseLocation, parseModelPayload, buildUpstreamUrl } = _aqModelInternals;

// LIVE CAPTURE — fetched 2026-09-27 from the build VM (HTTP 200, 367 bytes).
// This is a genuine upstream response, not a synthetic fixture.
const LIVE_CAPTURE = {
  latitude: 37.300003,
  longitude: -80.7,
  generationtime_ms: 0.2472400665283203,
  utc_offset_seconds: 0,
  timezone: 'GMT',
  timezone_abbreviation: 'GMT',
  elevation: 541.0,
  current_units: { time: 'iso8601', interval: 'seconds', pm2_5: 'μg/m³', ozone: 'μg/m³', us_aqi: 'USAQI' },
  current: { time: '2026-09-27T21:00', interval: 3600, pm2_5: 2.4, ozone: 97.0, us_aqi: 40 },
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

test('aqModelProxy mounts /api/aq-model on both server shapes', () => {
  const routes = mount(aqModelProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/aq-model', '/api/aq-model']);
});

test('parseLocation validates lat/lon', () => {
  const loc = parseLocation(new URLSearchParams('lat=37.2673&lon=-80.7266'));
  assert.deepEqual(loc, { lat: 37.267, lon: -80.727 });
  assert.throws(() => parseLocation(new URLSearchParams('lat=91&lon=0')), /aq_bad_lat/);
  assert.throws(() => parseLocation(new URLSearchParams('lat=0&lon=181')), /aq_bad_lon/);
  assert.throws(() => parseLocation(new URLSearchParams('lat=abc&lon=0')), /aq_bad_lat/);
  assert.throws(() => parseLocation(new URLSearchParams('')), /aq_bad_lat/);
});

test('parseModelPayload labels the live capture as MODEL output', () => {
  const payload = parseModelPayload(LIVE_CAPTURE, { lat: 37.267, lon: -80.727 });
  assert.equal(payload.model, true);
  assert.match(payload.modelName, /CAMS/);
  assert.match(payload.warning, /not physical sensor observations/);
  assert.equal(payload.current.pm2_5, 2.4);
  assert.equal(payload.current.ozone, 97.0);
  assert.equal(payload.current.usAqi, 40);
  assert.equal(payload.current.units.pm2_5, 'μg/m³');
  assert.deepEqual(payload.location.requested, { lat: 37.267, lon: -80.727 });
  assert.equal(payload.location.gridLat, 37.300003);
  assert.equal(payload.location.elevationM, 541.0);
  assert.ok(payload.attribution.includes('Open-Meteo'));
});

test('parseModelPayload tolerates missing current block', () => {
  const payload = parseModelPayload({ latitude: 0, longitude: 0 }, { lat: 0, lon: 0 });
  assert.equal(payload.model, true);
  assert.equal(payload.current.pm2_5, null);
  assert.equal(payload.current.usAqi, null);
});

test('buildUpstreamUrl requests exactly the catalog params', () => {
  const url = buildUpstreamUrl({ lat: 37.267, lon: -80.727 });
  assert.match(url, /^https:\/\/air-quality-api\.open-meteo\.com\/v1\/air-quality\?/);
  assert.match(url, /current=pm2_5%2Cozone%2Cus_aqi/);
  assert.match(url, /latitude=37\.267/);
  assert.match(url, /longitude=-80\.727/);
});

test('handler serves model-labeled snapshot with mocked fetch', async () => {
  _aqModelInternals.clearCaches();
  const calls = mount(aqModelProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /^https:\/\/air-quality-api\.open-meteo\.com/);
    return new Response(JSON.stringify(LIVE_CAPTURE), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/aq-model?lat=37.2673&lon=-80.7266'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.model, true);
    assert.equal(payload.current.pm2_5, 2.4);
    assert.match(payload.warning, /MODEL/);
    assert.match(res.headers['Cache-Control'], /max-age=600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler caches repeat queries without refetching', async () => {
  _aqModelInternals.clearCaches();
  const calls = mount(aqModelProxy());
  const realFetch = globalThis.fetch;
  let calls2 = 0;
  globalThis.fetch = async () => {
    calls2 += 1;
    return new Response(JSON.stringify(LIVE_CAPTURE), { status: 200 });
  };
  try {
    await calls[0].handler(fakeReq('/api/aq-model?lat=37&lon=-80'), fakeRes());
    await calls[0].handler(fakeReq('/api/aq-model?lat=37&lon=-80'), fakeRes());
    assert.equal(calls2, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when the upstream is down', async () => {
  _aqModelInternals.clearCaches();
  const calls = mount(aqModelProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/aq-model?lat=37&lon=-80'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /aq_model_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects missing coords with 400 and non-GET with 405', async () => {
  const calls = mount(aqModelProxy());
  const bad = fakeRes();
  await calls[0].handler(fakeReq('/api/aq-model?lat=37'), bad);
  assert.equal(bad.statusCode, 400);
  assert.match(bad.body, /aq_bad_lon/);
  const post = fakeRes();
  await calls[0].handler(fakeReq('/api/aq-model?lat=37&lon=-80', 'POST'), post);
  assert.equal(post.statusCode, 405);
});
