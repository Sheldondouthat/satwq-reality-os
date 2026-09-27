import assert from 'node:assert/strict';
import test from 'node:test';
import { cometsProxy, _cometsInternals } from './comets.js';

const { trimObservation, trimObservations, rollupComets, trimCometPayload } = _cometsInternals;

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

// Shapes follow the catalog's documented COBS JSON layout (VM-throttled 2026-09-27).

const SAMPLE_OBS = [
  { des: '29P/Schwassmann-Wachmann', date: '2026-09-26T21:10:00Z', mag: '13.2', obs_name: 'J. Doe', method: 'CCD', coma: '1.5', dc: '3', tail: '0.2' },
  { des: '29P/Schwassmann-Wachmann', date: '2026-09-25T21:05:00Z', mag: '13.4', obs_name: 'A. Smith', method: 'CCD', coma: '1.4' },
  { des: 'C/2025 R2 (SWAN)', date: '2026-09-26T02:00:00Z', mag: '9.8', obs_name: 'J. Doe', method: 'VIS', coma: '4.0', dc: '5', tail: '1.5' },
  { mag: '12.0', obs_name: 'no designation' }, // junk: dropped
];

test('cometsProxy mounts /api/comets on both server shapes', () => {
  const routes = mount(cometsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/comets', '/api/comets']);
});

test('trimObservation keeps ticker fields and rounds magnitude', () => {
  const o = trimObservation(SAMPLE_OBS[0]);
  assert.equal(o.des, '29P/Schwassmann-Wachmann');
  assert.equal(o.date, '2026-09-26T21:10:00.000Z');
  assert.equal(o.mag, 13.2);
  assert.equal(o.observer, 'J. Doe');
  assert.equal(o.method, 'CCD');
  assert.equal(o.comaArcmin, 1.5);
  assert.equal(o.dc, 3);
  assert.equal(o.tailDeg, 0.2);
});

test('trimObservation drops records without a designation', () => {
  assert.equal(trimObservation(SAMPLE_OBS[3]), null);
});

test('trimObservation tolerates missing magnitude', () => {
  const o = trimObservation({ des: '1P/Halley', date: '2026-09-20' });
  assert.equal(o.mag, null);
  assert.equal(o.observer, '');
});

test('trimObservations sorts newest-first and drops junk', () => {
  const list = trimObservations(SAMPLE_OBS);
  assert.equal(list.length, 3);
  assert.equal(list[0].des, '29P/Schwassmann-Wachmann');
  assert.equal(list[0].date, '2026-09-26T21:10:00.000Z');
});

test('rollupComets keeps one row per comet with the latest observation', () => {
  const list = trimObservations(SAMPLE_OBS);
  const comets = rollupComets(list);
  assert.equal(comets.length, 2);
  const sw1 = comets.find((c) => c.des === '29P/Schwassmann-Wachmann');
  assert.equal(sw1.observations, 2);
  assert.equal(sw1.latestMag, 13.2);
  assert.equal(sw1.latestDate, '2026-09-26T21:10:00.000Z');
});

test('handler serves rollup + observations with mocked fetch', async () => {
  _cometsInternals.clearCaches();
  const calls = mount(cometsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify(SAMPLE_OBS), { status: 200, headers: { 'Content-Type': 'application/json' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/comets'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 3);
    assert.equal(payload.comets.length, 2);
    assert.equal(payload.windowDays, 30);
    assert.match(res.headers['Cache-Control'], /max-age=3600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when COBS is down', async () => {
  _cometsInternals.clearCaches();
  const calls = mount(cometsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/comets'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /comets_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(cometsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/comets', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
