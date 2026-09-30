import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { goesProxy, _goesInternals } from './goes.js';

const {
  numOrNull,
  hourPrefix,
  parseGoesKey,
  parseListBucketXml,
  selectLatest,
  buildGoesPayload,
  clearCaches,
} = _goesInternals;

// REAL capture — fetched 2026-09-30 from the build VM
// (https://noaa-goes18.s3.amazonaws.com/?list-type=2&max-keys=120&prefix=ABI-L2-CMIPF/2026/273/07/,
// HTTP 200, 80 keys). Trimmed to 7 <Contents> blocks: C01 scans at
// 07:00:20/07:10:20/07:20:20, C04 scans at 07:10:20/07:20:20/07:30:20,
// plus one malformed key (sBROKEN — must be skipped, counted, never
// plotted). Latest parseable scan = 07:30:20.5 UTC.
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE = readFileSync(
  join(ROOT, 'goals', 'finish-all-my-work', 'hidden_files', 'probes-2026-09-30-0342', 'goes18-fixture.xml'),
  'utf8',
);
const EMPTY_LIST = (name) =>
  `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${name}</Name><KeyCount>0</KeyCount><MaxKeys>120</MaxKeys><IsTruncated>false</IsTruncated></ListBucketResult>`;

// nowMs picked so the fixture's latest scan (07:30:20.5Z) is 300s old → fresh.
const NOW_FRESH = Date.parse('2026-09-30T07:35:20+00:00');
const NOW_DARK = NOW_FRESH + 2 * 3600_000; // +2h: age 7500s > DARK_SEC

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

/** Fake fetch: S3 LIST returns fixture for G18/G19, empty lists for G16/G17; HEADs 200. */
function fakeFetchOk(url, opts = {}) {
  if (opts.method === 'HEAD') return Promise.resolve({ ok: true, status: 200 });
  const u = String(url);
  const body = u.includes('noaa-goes16') || u.includes('noaa-goes17')
    ? EMPTY_LIST(u.includes('noaa-goes16') ? 'noaa-goes16' : 'noaa-goes17')
    : FIXTURE;
  return Promise.resolve({
    ok: true,
    status: 200,
    headers: { get: () => null }, // real fetch Responses always carry headers
    text: () => Promise.resolve(body),
  });
}

test('numOrNull: null/empty-string numerics become null, never 0', () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('   '), null);
  assert.equal(numOrNull('3.5'), 3.5);
  assert.equal(numOrNull('abc'), null);
});

test('hourPrefix: UTC hour path with 3-digit DOY', () => {
  assert.equal(hourPrefix(Date.parse('2026-09-30T07:35:20Z')), 'ABI-L2-CMIPF/2026/273/07/');
  assert.equal(hourPrefix(Date.parse('2026-01-01T00:05:00Z')), 'ABI-L2-CMIPF/2026/001/00/');
  assert.equal(hourPrefix(Date.parse('2026-12-31T23:59:59Z')), 'ABI-L2-CMIPF/2026/365/23/');
});

test('parseGoesKey: valid CMIPF key → channel/sat/scanStartMs', () => {
  const p = parseGoesKey('OR_ABI-L2-CMIPF-M6C02_G18_s20262730700205_e20262730709514_c20262730709564.nc');
  assert.equal(p.channel, 2);
  assert.equal(p.sat, 'G18');
  assert.equal(p.scanStartMs, Date.parse('2026-09-30T07:00:20Z'));
});

test('parseGoesKey: malformed keys → null (never a fabricated timestamp)', () => {
  assert.equal(parseGoesKey('OR_ABI-L2-CMIPF-M6C01_G18_sBROKEN_e20262730709513_c20262730709564.nc'), null);
  assert.equal(parseGoesKey('not-a-key.nc'), null);
  assert.equal(parseGoesKey(null), null);
  // out-of-range DOY must not silently overflow via Date.UTC
  assert.equal(parseGoesKey('OR_ABI-L2-CMIPF-M6C01_G18_s20269990700205_e20262730709514_c20262730709564.nc'), null);
});

test('parseListBucketXml: real fixture → 7 entries, not truncated', () => {
  const { entries, truncated } = parseListBucketXml(FIXTURE);
  assert.equal(entries.length, 7);
  assert.equal(truncated, false);
  assert.ok(entries[0].key.includes('M6C01_G18'));
  assert.equal(entries[0].sizeBytes, 4450312);
});

test('parseListBucketXml: non-ListBucketResult → throws 502', () => {
  assert.throws(() => parseListBucketXml('<html>nope</html>'), (e) => e.status === 502);
  assert.throws(() => parseListBucketXml(''), (e) => e.status === 502);
});

test('selectLatest: latest scan wins regardless of XML order; malformed counted as skipped', () => {
  const { entries } = parseListBucketXml(FIXTURE);
  const { entry, parsed, skipped, channels } = selectLatest(entries);
  assert.equal(skipped, 1);
  assert.equal(channels, 2);
  assert.equal(parsed.scanStartMs, Date.parse('2026-09-30T07:30:20Z'));
  assert.ok(entry.key.includes('M6C04_G18'));
});

test('handler: full pass — G18/G19 fresh, G16/G17 dark-from-live-listing', async () => {
  clearCaches();
  const provider = goesProxy({ fetchImpl: fakeFetchOk, now: () => NOW_FRESH });
  const [{ handler }] = mount(provider);
  const res = fakeRes();
  await handler(fakeReq('/api/goes'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.summary.total, 4);
  assert.equal(body.summary.fresh, 2);
  assert.equal(body.summary.dark, 2);
  assert.equal(body.summary.operational, 2);
  const g18 = body.satellites.find((s) => s.sat === 'G18');
  assert.equal(g18.fresh, true);
  assert.equal(g18.dark, false);
  assert.equal(g18.ageSec, 300);
  assert.equal(g18.latestScan, '2026-09-30T07:30:20.000Z');
  assert.equal(g18.imageryOk, true);
  assert.ok(g18.imageryUrl.includes('GOES18/ABI/FD/GEOCOLOR/latest.jpg'));
  assert.ok(g18.honesty.includes('not a rendered picture'));
  const g16 = body.satellites.find((s) => s.sat === 'G16');
  assert.equal(g16.dark, true);
  assert.equal(g16.darkReason, 'no files in current+previous UTC hour');
  assert.equal(g16.latestScan, null);
  assert.ok(body.attribution.includes('noaa-goes16/17/18/19'));
});

test('handler: dark when the latest scan is >60 min old', async () => {
  clearCaches();
  const provider = goesProxy({ fetchImpl: fakeFetchOk, now: () => NOW_DARK });
  const [{ handler }] = mount(provider);
  const res = fakeRes();
  await handler(fakeReq('/api/goes'), res);
  const body = JSON.parse(res.body);
  const g18 = body.satellites.find((s) => s.sat === 'G18');
  assert.equal(g18.dark, true);
  assert.equal(g18.darkReason, 'latest scan older than 60 min');
  assert.equal(g18.ageSec, 7500);
});

test('handler: ?sat=G18 single lookup; ?sat=G99 → 200 + requestedNotFound', async () => {
  clearCaches();
  const provider = goesProxy({ fetchImpl: fakeFetchOk, now: () => NOW_FRESH });
  const [{ handler }] = mount(provider);
  let res = fakeRes();
  await handler(fakeReq('/api/goes?sat=G18'), res);
  assert.equal(res.statusCode, 200);
  let body = JSON.parse(res.body);
  assert.equal(body.count, 1);
  assert.equal(body.satellites[0].sat, 'G18');
  assert.equal(body.requestedNotFound, false);
  res = fakeRes();
  await handler(fakeReq('/api/goes?sat=G99'), res);
  assert.equal(res.statusCode, 200);
  body = JSON.parse(res.body);
  assert.equal(body.requestedNotFound, true);
  assert.equal(body.count, 0);
});

test('handler: malformed ?sat → 400; POST → 405', async () => {
  clearCaches();
  const provider = goesProxy({ fetchImpl: fakeFetchOk, now: () => NOW_FRESH });
  const [{ handler }] = mount(provider);
  let res = fakeRes();
  await handler(fakeReq('/api/goes?sat=!!!'), res);
  assert.equal(res.statusCode, 400);
  res = fakeRes();
  await handler(fakeReq('/api/goes', 'POST'), res);
  assert.equal(res.statusCode, 405);
});

test('handler: upstream LIST 500 → honest 502, never 500', async () => {
  clearCaches();
  const bad = () => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('') });
  const provider = goesProxy({ fetchImpl: bad, now: () => NOW_FRESH });
  const [{ handler }] = mount(provider);
  const res = fakeRes();
  await handler(fakeReq('/api/goes'), res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'goes_unavailable');
});

test('handler: imagery HEAD failure is fail-soft (never 502s the route)', async () => {
  clearCaches();
  const flakyHead = (url, opts = {}) => {
    if (opts.method === 'HEAD') return Promise.reject(new Error('head failed'));
    return fakeFetchOk(url, opts);
  };
  const provider = goesProxy({ fetchImpl: flakyHead, now: () => NOW_FRESH });
  const [{ handler }] = mount(provider);
  const res = fakeRes();
  await handler(fakeReq('/api/goes'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const g18 = body.satellites.find((s) => s.sat === 'G18');
  assert.equal(g18.imageryOk, false);
  assert.equal(g18.imageryStatus, null);
});

test('handler: stale fallback is key-scoped', async () => {
  clearCaches();
  const provider = goesProxy({ fetchImpl: fakeFetchOk, now: () => NOW_FRESH });
  const [{ handler }] = mount(provider);
  let res = fakeRes();
  await handler(fakeReq('/api/goes?sat=G18'), res);
  assert.equal(res.statusCode, 200);
  // now break the upstream and advance past the doc TTL but within STALE_MS
  const dead = () => Promise.reject(new Error('fetch failed'));
  const provider2 = goesProxy({ fetchImpl: dead, now: () => NOW_FRESH + 6 * 60_000 });
  // NOTE: caches are module-level; the second proxy shares them — this is
  // the production shape (single module instance per worker).
  const [{ handler: h2 }] = mount(provider2);
  res = fakeRes();
  await h2(fakeReq('/api/goes?sat=G18'), res);
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).stale, true);
});

test('buildGoesPayload: pure summary math', () => {
  const rows = [
    { sat: 'G18', fresh: true, dark: false },
    { sat: 'G19', fresh: true, dark: false },
    { sat: 'G16', fresh: false, dark: true },
    { sat: 'G17', fresh: false, dark: true },
  ];
  const p = buildGoesPayload(rows, { nowMs: NOW_FRESH, query: { sat: null, key: '' } });
  assert.equal(p.summary.total, 4);
  assert.equal(p.summary.fresh, 2);
  assert.equal(p.summary.dark, 2);
  assert.equal(p.count, 4);
  assert.equal(p.requestedNotFound, false);
});
