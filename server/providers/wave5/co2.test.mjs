import assert from 'node:assert/strict';
import test from 'node:test';
import { co2Proxy, _co2Internals } from './co2.js';

const { parseCo2Csv, pickLatestAndYearAgo, trimCo2Payload, clearCaches } = _co2Internals;

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
  return { method, url: '/api/co2', originalUrl: '/api/co2', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

const SAMPLE_CSV = [
  '# comment header',
  '2025,9,22,2025.7233,426.11',
  '2025,9,23,2025.7260,426.40',
  '2025,9,24,2025.7287,426.31',
  '2026,9,22,2026.7233,428.90',
  '2026,9,23,2026.7260,-999.99', // missing-day flag: excluded
  '2026,9,24,2026.7287,429.03',
].join('\n');

test('co2Proxy mounts /api/co2 on both server shapes', () => {
  const routes = mount(co2Proxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/co2', '/api/co2']);
});

test('parseCo2Csv skips comments and -999.99 missing days', () => {
  const rows = parseCo2Csv(SAMPLE_CSV);
  assert.equal(rows.length, 5);
  assert.ok(rows.every((r) => r.ppm !== -999.99));
  assert.equal(rows[rows.length - 1].ppm, 429.03);
});

test('pickLatestAndYearAgo finds exact prior-year date', () => {
  const { latest, yearAgo } = pickLatestAndYearAgo(parseCo2Csv(SAMPLE_CSV));
  assert.equal(latest.ppm, 429.03);
  assert.equal(yearAgo.ppm, 426.31);
  assert.equal(yearAgo.year, 2025);
});

test('trimCo2Payload builds the ticker payload with delta', () => {
  const p = trimCo2Payload(SAMPLE_CSV);
  assert.equal(p.value, 429.03);
  assert.equal(p.ppm, 429.03);
  assert.equal(p.date, '2026-09-24');
  assert.equal(p.delta1yPpm, 2.72);
  assert.equal(p.unit, 'ppm');
  assert.match(p.attribution, /NOAA GML/);
});

test('trimCo2Payload throws 502 on an empty parse', () => {
  assert.throws(() => trimCo2Payload('# nothing here\n'), /co2_no_rows/);
});

test('handler serves trimmed payload with mocked fetch', async () => {
  const calls = mount(co2Proxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(SAMPLE_CSV, { status: 200, headers: { 'Content-Type': 'text/csv' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq(), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.ppm, 429.03);
    assert.equal(payload.delta1yPpm, 2.72);
    assert.match(res.headers['Cache-Control'], /max-age=21600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  clearCaches();
  const calls = mount(co2Proxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq(), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /co2_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(co2Proxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});
