import assert from 'node:assert/strict';
import test from 'node:test';
import { asteroidsProxy, _asteroidsInternals } from './asteroids.js';

const { trimApproach, clearCaches } = _asteroidsInternals;

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

// ——— fixture: cad.api {signature, count, fields, data} shape ———

const CAD_FIXTURE = {
  signature: { source: 'NASA/JPL Small-Body Database (SBDB) Close-Approach Data API', version: '1.2' },
  count: 2,
  fields: ['des', 'orbit_id', 'jd', 'cd', 'dist', 'dist_min', 'dist_max', 'v_rel', 'v_inf', 't_sigma_f', 'h', 'fullname'],
  data: [
    ['2026 AA', '1', '2460950.1234567', '2026-10-05 12:34:56.789', '0.0012345', '0.0012340', '0.0012350', '12.345', '12.012', '1:23', '24.5', '2026 AA'],
    ['(2026 BB1)', '2', '2460960.0000000', '2026-10-15 00:00:00.000', '0.0035000', '0.0034990', '0.0035010', '7.89', '7.50', '<1m', '', '(2026 BB1)'],
  ],
};

function mockFetchFor(fixture, capture) {
  return async (url) => {
    capture?.push(String(url));
    if (fixture === null) return new Response('down', { status: 503 });
    return new Response(JSON.stringify(fixture), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('asteroidsProxy mounts /api/asteroids on both server shapes', () => {
  const routes = mount(asteroidsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/asteroids', '/api/asteroids']);
});

test('trimApproach keeps only the catalog-#65 field set', () => {
  const row = {
    des: '2026 AA',
    closeApproachUtc: '2026-10-05 12:34:56.789',
    distAu: 0.00123456,
    distLd: 0.48091234,
    vRelKms: 12.3456,
    absMagH: 24.5,
    name: 'should be dropped',
    diameterEstM: { dropped: true },
  };
  assert.deepEqual(trimApproach(row), {
    des: '2026 AA',
    cd: '2026-10-05 12:34:56.789',
    distAu: 0.001235,
    distLd: 0.481,
    vRelKms: 12.35,
    h: 24.5,
  });
  // blank H stays honest: null, not a fabricated magnitude
  const noH = trimApproach({ ...row, absMagH: null });
  assert.equal(noH.h, null);
});

test('handler returns trimmed catalog shape with mocked fetch', async () => {
  clearCaches();
  const calls = mount(asteroidsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchFor(CAD_FIXTURE);
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/asteroids'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.ok(payload.generatedAt);
    assert.equal(payload.count, 2);
    assert.equal(payload.approaches.length, 2);
    const [first] = payload.approaches;
    assert.deepEqual(Object.keys(first).sort(), ['cd', 'des', 'distAu', 'distLd', 'h', 'vRelKms']);
    assert.equal(first.des, '2026 AA');
    assert.equal(first.cd, '2026-10-05 12:34:56.789');
    assert.ok(Math.abs(first.distAu - 0.001235) < 1e-9);
    assert.equal(first.vRelKms, 12.35);
    assert.equal(first.h, 24.5);
    assert.equal(payload.approaches[1].h, null);
    assert.match(res.headers['Cache-Control'], /max-age=1800/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler passes date-min/date-max/dist-max through to the upstream', async () => {
  clearCaches();
  const calls = mount(asteroidsProxy());
  const realFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = mockFetchFor(CAD_FIXTURE, captured);
  try {
    const res = fakeRes();
    await calls[0].handler(
      fakeReq('/api/asteroids?date-min=2026-09-01&date-max=2026-10-31&dist-max=0.05'),
      res,
    );
    assert.equal(res.statusCode, 200);
    assert.equal(captured.length, 1);
    const url = new URL(captured[0]);
    assert.equal(url.hostname, 'ssd-api.jpl.nasa.gov');
    assert.equal(url.searchParams.get('date-min'), '2026-09-01');
    assert.equal(url.searchParams.get('date-max'), '2026-10-31');
    assert.equal(url.searchParams.get('dist-max'), '0.05');
    const payload = JSON.parse(res.body);
    assert.equal(payload.window.from, '2026-09-01');
    assert.equal(payload.window.to, '2026-10-31');
    assert.equal(payload.window.distMaxAu, 0.05);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects bad params with 400 and an honest error', async () => {
  const calls = mount(asteroidsProxy());
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls += 1; return new Response('{}', { status: 200 }); };
  try {
    for (const url of [
      '/api/asteroids?date-min=not-a-date',
      '/api/asteroids?date-max=2026-13-99',
      '/api/asteroids?date-min=2026-10-31&date-max=2026-09-01',
      '/api/asteroids?dist-max=5',
      '/api/asteroids?dist-max=abc',
    ]) {
      clearCaches();
      const res = fakeRes();
      await calls[0].handler(fakeReq(url), res);
      assert.equal(res.statusCode, 400, url);
      assert.match(res.body, /asteroids_bad_request/);
      assert.match(res.body, /neo_bad_param/);
    }
    assert.equal(fetchCalls, 0); // invalid input never touches the upstream
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler caches per param key (upstream fetched once per window)', async () => {
  clearCaches();
  const calls = mount(asteroidsProxy());
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(JSON.stringify(CAD_FIXTURE), { status: 200 });
  };
  try {
    const same = '/api/asteroids?date-min=2026-09-01&date-max=2026-10-31&dist-max=0.05';
    await calls[0].handler(fakeReq(same), fakeRes());
    await calls[0].handler(fakeReq(same), fakeRes());
    assert.equal(fetchCalls, 1);
    // a different window key hits the upstream again
    await calls[0].handler(
      fakeReq('/api/asteroids?date-min=2026-09-01&date-max=2026-10-31&dist-max=0.1'),
      fakeRes(),
    );
    assert.equal(fetchCalls, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when the upstream is down', async () => {
  clearCaches();
  const calls = mount(asteroidsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = mockFetchFor(null);
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/asteroids'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /asteroids_upstream_unavailable/);
    assert.match(res.headers['Cache-Control'], /no-store/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(asteroidsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/asteroids', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
