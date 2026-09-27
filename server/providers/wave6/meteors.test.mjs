import assert from 'node:assert/strict';
import test from 'node:test';
import { meteorsProxy, _meteorsInternals } from './meteors.js';

const { parseRmob, stationFileUrl, buildSnapshot } = _meteorsInternals;

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

const SAMPLE_TXT = [
  'Norton RMOB station — monthly meteor forward-scatter counts',
  '2026 09 25 22    12    8    5    3',
  '2026 09 25 23    15   10    6    4',
  '2026 09 26 00    20   14    7    5',
  '',
  'not a data line, ignored after header',
].join('\n');

test('meteorsProxy mounts /api/meteors on both server shapes', () => {
  const routes = mount(meteorsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/meteors', '/api/meteors']);
});

test('stationFileUrl follows the catalog MMYYYY naming', () => {
  assert.equal(
    stationFileUrl('Norton', new Date(Date.UTC(2026, 8, 27))),
    'https://www.rmob.org/livedata/live_datas/Norton_092026rmob.TXT',
  );
});

test('parseRmob rolls hourly bins into per-hour counts', () => {
  const s = parseRmob('Norton', SAMPLE_TXT);
  assert.equal(s.code, 'Norton');
  assert.equal(s.count, 3);
  assert.equal(s.totalCount, 28 + 35 + 46);
  assert.equal(s.hourly[0].timeISO, '2026-09-25T22:00:00.000Z');
  assert.equal(s.hourly[0].count, 28);
  assert.equal(s.hourly[0].bins, 4);
  assert.equal(s.hourly[2].timeISO, '2026-09-26T00:00:00.000Z');
});

test('parseRmob sorts hours chronologically regardless of input order', () => {
  const s = parseRmob('Norton', '2026 09 26 00    5\n2026 09 25 22    3\n');
  assert.equal(s.hourly[0].timeISO, '2026-09-25T22:00:00.000Z');
  assert.equal(s.hourly[1].timeISO, '2026-09-26T00:00:00.000Z');
});

test('parseRmob ignores malformed date rows and keeps going', () => {
  const s = parseRmob('Norton', '2026 99 99 99   10\n2026 09 26 01   7\n');
  assert.equal(s.count, 1);
  assert.equal(s.totalCount, 7);
});

test('parseRmob on empty input yields zero rows', () => {
  const s = parseRmob('Norton', '');
  assert.equal(s.count, 0);
  assert.equal(s.totalCount, 0);
});

test('buildSnapshot records per-station errors honestly', () => {
  const payload = buildSnapshot([
    { key: 'rmob_norton', ok: false, count: 0, attribution: 'RMOB', latencyMs: 9, error: 'meteors_rmob_norton_upstream_503', station: null },
  ]);
  assert.equal(payload.count, 0);
  assert.equal(payload.sources.rmob_norton.ok, false);
  assert.match(payload.sources.rmob_norton.error, /503/);
});

test('handler serves parsed station with mocked fetch', async () => {
  _meteorsInternals.clearCaches();
  const calls = mount(meteorsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(SAMPLE_TXT, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/meteors'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 1);
    assert.equal(payload.stations[0].count, 3);
    assert.equal(payload.stations[0].totalCount, 28 + 35 + 46);
    assert.match(res.headers['Cache-Control'], /max-age=3600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when the station file is down', async () => {
  _meteorsInternals.clearCaches();
  const calls = mount(meteorsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/meteors'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /meteors_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(meteorsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/meteors', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
