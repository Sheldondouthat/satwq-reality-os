/**
 * Wave 9 (R2-4) — USDM provider tests.
 *
 * Fixtures are REAL bytes: the 553-byte CSV fetched 2026-09-30 from the build
 * VM (https://usdmdataservices.unl.edu/api/USStatistics/GetBasicStatisticsByAreaPercent
 * ?aoi=TOTAL&dx=1&DxLevelThresholdFrom=0&DxLevelThresholdTo=70
 * &startdate=9/23/2026&enddate=9/30/2026&statisticsType=1, HTTP 200).
 * A second fixture carries two weekly maps (2026-09-15 + 2026-09-22) to pin
 * the provider-computed week-over-week deltas.
 */
import assert from 'node:assert/strict';
import test, { beforeEach } from 'node:test';
import {
  parseCsvLine,
  parseUsdmCsv,
  selectWeeks,
  buildUsdmPayload,
  usdmProxy,
  clearUsdmCaches,
} from './usdm.js';

const HEADER =
  'AreaOfInterest,AreaCurrentPercent,AreaCurrent,PopulationCurrent,PopulationCurrentPercent,PercentChangeFromWAve,AreaChangeFromWAve,StatisticFormatID,USDMLevelID,USDMLevel,AreaMiles,MapDate';

// REAL capture — 2026-09-30, HTTP 200, MapDate 2026-09-22 (current week).
const REAL_CSV = `${HEADER}
Total,49.65,"1,787,430.62","105,567,337.82",33.89,0.00,0.00,1,2,D1,"3,599,751.15",2026-09-22
Total,28.10,"1,011,417.20","54,807,442.58",17.60,0.00,0.00,1,3,D2,"3,599,751.15",2026-09-22
Total,10.17,"366,233.22","20,670,928.05",6.64,0.00,0.00,1,4,D3,"3,599,751.15",2026-09-22
Total,1.77,"63,592.20","2,857,315.64",0.92,0.00,0.00,1,5,D4,"3,599,751.15",2026-09-22
`;

// Two weeks: previous week rows are the REAL 2026-09-15 capture (live bytes).
const TWO_WEEK_CSV = `${HEADER}
Total,49.77,"1,791,626.64","103,473,377.71",33.22,0.00,0.00,1,2,D1,"3,599,751.15",2026-09-15
Total,28.31,"1,019,062.43","53,655,417.67",17.23,0.00,0.00,1,3,D2,"3,599,751.15",2026-09-15
Total,10.51,"378,284.52","21,910,247.94",7.03,0.00,0.00,1,4,D3,"3,599,751.15",2026-09-15
Total,1.68,"60,606.19","1,252,793.45",0.40,0.00,0.00,1,5,D4,"3,599,751.15",2026-09-15
Total,49.65,"1,787,430.62","105,567,337.82",33.89,0.00,0.00,1,2,D1,"3,599,751.15",2026-09-22
Total,28.10,"1,011,417.20","54,807,442.58",17.60,0.00,0.00,1,3,D2,"3,599,751.15",2026-09-22
Total,10.17,"366,233.22","20,670,928.05",6.64,0.00,0.00,1,4,D3,"3,599,751.15",2026-09-22
Total,1.77,"63,592.20","2,857,315.64",0.92,0.00,0.00,1,5,D4,"3,599,751.15",2026-09-22
`;

const NOW = Date.parse('2026-09-30T16:00:00Z');

// Module caches are shared across tests in this file: reset before each
// handler test so the stale-fallback path never masks a fresh failure.
beforeEach(() => clearUsdmCaches());

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
  return { method, url, once() {}, removeListener() {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

/** Fake fetch returning CSV text with a headers.get stub (readResponseTextCapped path). */
function fakeFetchOk(text) {
  return async () => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => text,
    body: null,
  });
}

test('parseCsvLine handles quoted thousands separators', () => {
  const f = parseCsvLine('Total,49.65,"1,787,430.62","105,567,337.82",33.89');
  assert.equal(f[0], 'Total');
  assert.equal(f[1], '49.65');
  assert.equal(f[2], '1,787,430.62');
  assert.equal(f[3], '105,567,337.82');
  assert.equal(f[4], '33.89');
});

test('parseUsdmCsv parses the real 2026-09-30 capture', () => {
  const rows = parseUsdmCsv(REAL_CSV);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows.map((r) => r.level), ['D1', 'D2', 'D3', 'D4']);
  assert.equal(rows[0].areaPercent, 49.65);
  assert.equal(rows[0].areaSqMi, 1787430.62); // quoted comma value, not NaN
  assert.equal(rows[0].population, 105567337.82);
  assert.equal(rows[0].mapDate, '2026-09-22');
  assert.equal(rows[3].areaPercent, 1.77);
});

test('parseUsdmCsv rejects bad shapes with 502, never fabricates', () => {
  for (const bad of ['', 'not csv at all', `${HEADER}\n`]) {
    assert.throws(() => parseUsdmCsv(bad), (e) => e.status === 502);
  }
  const wrongHeader = 'a,b,c\n1,2,3\n';
  assert.throws(() => parseUsdmCsv(wrongHeader), (e) => e.status === 502);
});

test('selectWeeks picks newest weeks first and keeps category order', () => {
  const rows = parseUsdmCsv(TWO_WEEK_CSV);
  const weeks = selectWeeks(rows, 2);
  assert.equal(weeks.length, 2);
  assert.equal(weeks[0].mapDate, '2026-09-22');
  assert.equal(weeks[1].mapDate, '2026-09-15');
  assert.deepEqual(weeks[0].categories.map((c) => c.level), ['D1', 'D2', 'D3', 'D4']);
  assert.equal(selectWeeks(rows, 1).length, 1);
});

test('buildUsdmPayload: summary, cumulative semantics, provider-computed wow deltas', () => {
  const rows = parseUsdmCsv(TWO_WEEK_CSV);
  const p = buildUsdmPayload(rows, { nowMs: NOW, query: { weeks: 2, key: 'weeks=2' } });
  assert.equal(p.mapDate, '2026-09-22');
  assert.equal(p.previousMapDate, '2026-09-15');
  assert.equal(p.weeks, 2);
  assert.equal(p.stale, false);
  // Cumulative semantics: D1 row = D1-or-worse.
  assert.equal(p.summary.d1PlusAreaPercent, 49.65);
  assert.equal(p.summary.d3PlusAreaPercent, 10.17);
  assert.equal(p.summary.populationInDrought, 105567337.82);
  assert.equal(p.summary.worstLevel, 'D4');
  assert.equal(p.summary.worstAreaPercent, 1.77);
  // WoW deltas are percentage POINTS computed from real consecutive rows:
  // D1: 49.65 - 49.77 = -0.12; D4: 1.77 - 1.68 = +0.09.
  const d1 = p.categories.find((c) => c.level === 'D1');
  const d4 = p.categories.find((c) => c.level === 'D4');
  assert.equal(d1.wowDeltaPctPoints, -0.12);
  assert.equal(d4.wowDeltaPctPoints, 0.09);
  assert.ok(p.honesty.deltas.includes('provider-computed'));
  assert.ok(p.attribution.includes('U.S. Drought Monitor'));
});

test('buildUsdmPayload with one week: deltas null, never zero-filled', () => {
  const rows = parseUsdmCsv(REAL_CSV);
  const p = buildUsdmPayload(rows, { nowMs: NOW, query: { weeks: 1, key: 'weeks=1' } });
  assert.equal(p.previousMapDate, null);
  for (const c of p.categories) assert.equal(c.wowDeltaPctPoints, null);
});

test('handler: 200 on the real capture via fake fetch', async () => {
  const provider = usdmProxy({ fetchImpl: fakeFetchOk(REAL_CSV), now: () => NOW });
  const [{ route, handler }] = mount(provider);
  assert.equal(route, '/api/usdm');
  const res = fakeRes();
  await handler(fakeReq('/api/usdm'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.mapDate, '2026-09-22');
  assert.equal(body.summary.d1PlusAreaPercent, 49.65);
});

test('handler: 400 on bad weeks param', async () => {
  const provider = usdmProxy({ fetchImpl: fakeFetchOk(REAL_CSV), now: () => NOW });
  const [{ handler }] = mount(provider);
  for (const q of ['/api/usdm?weeks=0', '/api/usdm?weeks=9', '/api/usdm?weeks=bogus']) {
    const res = fakeRes();
    await handler(fakeReq(q), res);
    assert.equal(res.statusCode, 400, q);
    assert.equal(JSON.parse(res.body).error, 'usdm_bad_request');
  }
});

test('handler: 405 on non-GET', async () => {
  const provider = usdmProxy({ fetchImpl: fakeFetchOk(REAL_CSV), now: () => NOW });
  const [{ handler }] = mount(provider);
  const res = fakeRes();
  await handler(fakeReq('/api/usdm', 'POST'), res);
  assert.equal(res.statusCode, 405);
});

test('handler: upstream 500 → honest 502, never 200 with fake data', async () => {
  const provider = usdmProxy({
    fetchImpl: async () => ({ ok: false, status: 500, headers: { get: () => null } }),
    now: () => NOW,
  });
  const [{ handler }] = mount(provider);
  const res = fakeRes();
  await handler(fakeReq('/api/usdm'), res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'usdm_unavailable');
});

test('handler: malformed CSV → 502 (parse throws, not empty 200)', async () => {
  const provider = usdmProxy({ fetchImpl: fakeFetchOk('garbage,not,csv\n'), now: () => NOW });
  const [{ handler }] = mount(provider);
  const res = fakeRes();
  await handler(fakeReq('/api/usdm'), res);
  assert.equal(res.statusCode, 502);
});
