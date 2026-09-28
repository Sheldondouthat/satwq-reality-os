import assert from 'node:assert/strict';
import test from 'node:test';
import { meteorsProxy, _meteorsInternals } from './meteors.js';

const { parseRmob, stationFileUrl, buildSnapshot, stations, sources } = _meteorsInternals;

const SEP2026 = new Date(Date.UTC(2026, 8, 27)); // September 2026

const HEADER_24 =
  'sep| 00h| 01h| 02h| 03h| 04h| 05h| 06h| 07h| 08h| 09h| 10h| 11h| 12h| 13h| 14h| 15h| 16h| 17h| 18h| 19h| 20h| 21h| 22h| 23h|';
const ZEROS_24 = Array(24).fill(' 0  ').join('|');
function matrixRow(day, counts) {
  // counts: array of 24 cell strings; day: number
  const cells = [` ${String(day).padStart(2, ' ')}`, ...counts.map((c) => ` ${c} `)];
  return `${cells.join('|')}|`;
}

// Real-format fixture: two days, first four hours nonzero, rest zero,
// plus the footer metadata lines real RMOB files carry.
// Day 25: 12+8+5+3 = 28. Day 26: 15+10+6+4 = 35. Total = 63.
const SAMPLE_TXT = [
  HEADER_24,
  matrixRow(25, ['12', '8', '5', '3', ...Array(20).fill('0')]),
  matrixRow(26, ['15', '10', '6', '4', ...Array(20).fill('0')]),
  '[Remarks]Windows XP',
  '[Soft FTP]Colorgramme RMOB Lab v 2.8',
].join('\n');

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

test('meteorsProxy mounts /api/meteor-stations on both server shapes', () => {
  const routes = mount(meteorsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/meteor-stations', '/api/meteor-stations']);
});

test('stationFileUrl follows the catalog MMYYYY naming', () => {
  assert.equal(
    stationFileUrl('Norton', new Date(Date.UTC(2026, 8, 27))),
    'https://www.rmob.org/livedata/live_datas/Norton_092026rmob.TXT',
  );
});

test('parseRmob parses the real matrix layout into hourly entries', () => {
  const s = parseRmob('Norton', SAMPLE_TXT, SEP2026);
  assert.equal(s.code, 'Norton');
  assert.equal(s.count, 48); // 2 days × 24 hours
  assert.equal(s.totalCount, 63); // 28 + 35, hand-computed
  assert.equal(s.hourly[0].timeISO, '2026-09-25T00:00:00.000Z');
  assert.equal(s.hourly[0].count, 12);
  assert.equal(s.hourly[0].bins, 1);
  assert.equal(s.hourly[1].timeISO, '2026-09-25T01:00:00.000Z');
  assert.equal(s.hourly[1].count, 8);
  assert.equal(s.hourly[47].timeISO, '2026-09-26T23:00:00.000Z');
  assert.equal(s.hourly[47].count, 0);
});

test('parseRmob sorts days chronologically regardless of row order', () => {
  const txt = [
    HEADER_24,
    matrixRow(26, ['15', ...Array(23).fill('0')]),
    matrixRow(25, ['12', ...Array(23).fill('0')]),
  ].join('\n');
  const s = parseRmob('Norton', txt, SEP2026);
  assert.equal(s.hourly[0].timeISO, '2026-09-25T00:00:00.000Z');
  assert.equal(s.hourly[0].count, 12);
  assert.equal(s.hourly[24].timeISO, '2026-09-26T00:00:00.000Z');
  assert.equal(s.hourly[24].count, 15);
});

test('parseRmob skips ??? and blank cells without zero-filling', () => {
  // hour0=5, hour1=???, hour2=blank, hour3=7, hours 4-23 zero (20 cells):
  // count = 1 + 1 + 20 = 22 entries; total = 5 + 7 = 12.
  const txt = [
    HEADER_24,
    ` 27| 5  | ??? |     | 7  |${ZEROS_24.slice(0, -1).split('|').slice(4).join('|')}|`,
  ].join('\n');
  const s = parseRmob('Norton', txt, SEP2026);
  assert.equal(s.count, 22);
  assert.equal(s.totalCount, 12);
  const hours = s.hourly.map((h) => h.timeISO);
  assert.ok(!hours.includes('2026-09-27T01:00:00.000Z'), '??? cell must be skipped');
  assert.ok(!hours.includes('2026-09-27T02:00:00.000Z'), 'blank cell must be skipped');
});

test('parseRmob skips footer metadata lines', () => {
  const txt = [
    HEADER_24,
    matrixRow(25, ['3', ...Array(23).fill('0')]),
    '[Remarks]Windows XP',
    '[Soft FTP]Colorgramme RMOB Lab v 2.8',
    "[E]z~heef~kljb'fkzl garbage",
  ].join('\n');
  const s = parseRmob('Norton', txt, SEP2026);
  assert.equal(s.count, 24);
  assert.equal(s.totalCount, 3);
});

test('parseRmob on empty input yields zero rows', () => {
  const s = parseRmob('Norton', '', SEP2026);
  assert.equal(s.count, 0);
  assert.equal(s.totalCount, 0);
});

test('parseRmob handles truncated (19-column) headers like the ??? stations', () => {
  const h19 = 'sep| 00h| 01h| 02h| 03h| 04h| 05h| 06h| 07h| 08h| 09h| 10h| 11h| 12h| 13h| 14h| 15h| 16h| 17h| 18h|';
  const txt = [
    h19,
    ' 01| 4  | 2  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  | 0  |',
  ].join('\n');
  const s = parseRmob('SVAKOV-R12', txt, SEP2026);
  assert.equal(s.count, 19);
  assert.equal(s.totalCount, 6);
  assert.equal(s.hourly[0].timeISO, '2026-09-01T00:00:00.000Z');
  assert.equal(s.hourly[18].timeISO, '2026-09-01T18:00:00.000Z');
});

test('station list pins the 65 verified 2026-09-28 stations', () => {
  assert.equal(stations.length, 65);
  assert.ok(stations.includes('Norton'));
  assert.ok(!stations.includes('OBSUPICE-R7'), 'all-??? file excluded');
  assert.ok(!stations.includes('SVAKOV-R12'), 'all-??? file excluded');
  assert.ok(!stations.includes('Thornett'), 'all-??? file excluded');
});

test('source keys are unique (McKeel/Mckeel disambiguated)', () => {
  const keys = sources.map((s) => s.key);
  assert.equal(new Set(keys).size, keys.length);
  assert.ok(keys.includes('rmob_mckeel'));
  assert.ok(keys.includes('rmob_mckeel_2'));
  assert.ok(keys.includes('rmob_norton'));
});

test('buildSnapshot records per-station errors honestly', () => {
  const payload = buildSnapshot([
    { key: 'rmob_norton', ok: false, count: 0, attribution: 'RMOB', latencyMs: 9, error: 'meteors_rmob_norton_upstream_503', station: null },
  ]);
  assert.equal(payload.count, 0);
  assert.equal(payload.sources.rmob_norton.ok, false);
  assert.match(payload.sources.rmob_norton.error, /503/);
});

test('handler serves parsed stations with mocked fetch', async () => {
  _meteorsInternals.clearCaches();
  const calls = mount(meteorsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(SAMPLE_TXT, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/meteor-stations'), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.count, 65);
    assert.equal(payload.stations[0].count, 48);
    assert.equal(payload.stations[0].totalCount, 63);
    assert.match(res.headers['Cache-Control'], /max-age=3600/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when every station file is down', async () => {
  _meteorsInternals.clearCaches();
  const calls = mount(meteorsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq('/api/meteor-stations'), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /meteors_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(meteorsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('/api/meteor-stations', 'POST'), res);
  assert.equal(res.statusCode, 405);
});
