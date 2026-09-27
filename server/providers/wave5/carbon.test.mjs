import assert from 'node:assert/strict';
import test from 'node:test';
import { carbonProxy, _carbonInternals } from './carbon.js';

const { trimCarbonPayload, clearCaches } = _carbonInternals;

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
  return { method, url: '/api/carbon', originalUrl: '/api/carbon', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const SAMPLE_UPSTREAM = {
  data: [
    {
      from: '2026-09-27T19:00Z',
      to: '2026-09-27T19:30Z',
      intensity: { forecast: 87, actual: 97, index: 'moderate' },
    },
  ],
};

test('carbonProxy mounts /api/carbon on both server shapes', () => {
  const routes = mount(carbonProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/carbon', '/api/carbon']);
});

test('trimCarbonPayload prefers actual over forecast', () => {
  const p = trimCarbonPayload(SAMPLE_UPSTREAM);
  assert.equal(p.value, 97);
  assert.equal(p.forecast, 87);
  assert.equal(p.actual, 97);
  assert.equal(p.valueIsForecast, false);
  assert.equal(p.index, 'moderate');
  assert.equal(p.unit, 'gCO₂/kWh');
  assert.equal(p.region, 'GB');
  assert.match(p.attribution, /National Grid ESO/);
});

test('trimCarbonPayload falls back to forecast and flags it', () => {
  const p = trimCarbonPayload({
    data: [{ from: 'f', to: 't', intensity: { forecast: 120, actual: null, index: 'high' } }],
  });
  assert.equal(p.value, 120);
  assert.equal(p.valueIsForecast, true);
});

test('trimCarbonPayload throws 502 on bad upstream shape', () => {
  assert.throws(() => trimCarbonPayload({}), /carbon_upstream_shape/);
  assert.throws(() => trimCarbonPayload({ data: [{ intensity: {} }] }), /carbon_no_intensity/);
});

test('handler serves trimmed payload with mocked fetch', async () => {
  const calls = mount(carbonProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(SAMPLE_UPSTREAM), { status: 200 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq(), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.value, 97);
    assert.equal(payload.index, 'moderate');
    assert.match(res.headers['Cache-Control'], /max-age=1800/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  clearCaches();
  const calls = mount(carbonProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq(), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /carbon_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(carbonProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});
