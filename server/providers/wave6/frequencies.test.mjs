import assert from 'node:assert/strict';
import test from 'node:test';
import { frequenciesProxy, _frequenciesInternals } from './frequencies.js';

const { trimTransmitter, clearCaches } = _frequenciesInternals;

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
  return { method, url: '/api/frequencies', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('frequenciesProxy mounts /api/frequencies on both server shapes', () => {
  const routes = mount(frequenciesProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/frequencies', '/api/frequencies']);
});

const TX_FIXTURE = {
  uuid: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
  description: 'UHF FM voice downlink',
  alive: true,
  type: 'Transmitter',
  uplink_low: null,
  uplink_high: null,
  downlink_low: 145900000,
  downlink_high: 145940000,
  mode: 'FM',
  invert: false,
  baud: 1200.0,
  satellite: { name: 'ISS' },
};

test('trimTransmitter converts Hz→MHz and resolves nested satellite name', () => {
  const t = trimTransmitter(TX_FIXTURE);
  assert.ok(t);
  assert.equal(t.id, TX_FIXTURE.uuid);
  assert.equal(t.satellite, 'ISS');
  assert.equal(t.mode, 'FM');
  assert.equal(t.alive, true);
  assert.deepEqual(t.downMHz, [145.9, 145.94]);
  assert.deepEqual(t.upMHz, [null, null]);
  assert.equal(t.baud, 1200);
  assert.equal(t.invert, false);
});

test('trimTransmitter accepts a plain-string satellite and rejects bad input', () => {
  const t = trimTransmitter({ ...TX_FIXTURE, satellite: 'NOAA-19' });
  assert.equal(t.satellite, 'NOAA-19');
  assert.equal(trimTransmitter(null), null);
  assert.equal(trimTransmitter({}), null, 'missing uuid → null');
  assert.equal(trimTransmitter('junk'), null);
});

test('handler pages through results, sorts alive-first, and reports totals', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  const page1 = {
    count: 3,
    next: 'https://db.satnogs.org/api/transmitters/?page=2&page_size=500',
    results: [
      { ...TX_FIXTURE, uuid: 'dead-1', alive: false, downlink_low: 437000000, downlink_high: 437100000 },
      { ...TX_FIXTURE, uuid: 'live-1', alive: true, downlink_low: 2400000000, downlink_high: 2400100000 },
    ],
  };
  const page2 = {
    count: 3,
    next: null,
    results: [{ ...TX_FIXTURE, uuid: 'live-2', alive: true, downlink_low: 145800000, downlink_high: 145820000 }],
  };
  const urls = [];
  globalThis.fetch = async (url) => {
    urls.push(String(url));
    const page = urls.length === 1 ? page1 : page2;
    return new Response(JSON.stringify(page), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    const [{ handler }] = mount(frequenciesProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.total, 3);
    assert.equal(body.shown, 3);
    assert.equal(body.truncated, false);
    assert.equal(urls.length, 2, 'follows the DRF next link');
    assert.ok(urls[0].includes('page_size=500'), 'first page requests page_size=500');
    // Alive first, then ascending downlink.
    assert.deepEqual(body.transmitters.map((t) => t.id), ['live-2', 'live-1', 'dead-1']);
    assert.deepEqual(body.transmitters[0].downMHz, [145.8, 145.82]);
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler sets truncated=true when pages remain after MAX_PAGES', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  const page = (n) => ({
    count: 9999,
    next: `https://db.satnogs.org/api/transmitters/?page=${n + 1}&page_size=500`,
    results: [{ ...TX_FIXTURE, uuid: `tx-${n}` }],
  });
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify(page(calls)), { status: 200 });
  };
  try {
    const [{ handler }] = mount(frequenciesProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    const body = JSON.parse(res.body);
    assert.equal(calls, 4, 'MAX_PAGES=4 bounds the daily refresh');
    assert.equal(body.truncated, true);
    assert.equal(body.shown, 4);
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler returns 502 JSON when the upstream is down', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const [{ handler }] = mount(frequenciesProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 502);
    assert.equal(JSON.parse(res.body).error, 'frequencies_unavailable');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
