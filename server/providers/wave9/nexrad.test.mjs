import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { nexradProxy, _nexradInternals } from './nexrad.js';

const {
  numOrNull,
  parseStationFeature,
  parseRadarStationsDoc,
  buildNexradPayload,
  clearCaches,
  FRESH_SEC,
  DARK_SEC,
} = _nexradInternals;

// REAL capture — fetched 2026-09-29 from the build VM
// (https://api.weather.gov/radar/stations, HTTP 200, application/geo+json,
// 208 features). Trimmed to 4 features: KOKX (WSR-88D, fresh scan), TIDS
// (TDWR), TLKA2 (Profiler, latency:null — honest unknown), and a malformed
// KOKX duplicate with null coords (must be skipped, counted, never plotted
// at 0,0 — the Number(null)===0 bug class).
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const FIXTURE = readFileSync(
  join(ROOT, 'goals', 'finish-all-my-work', 'hidden_files', 'probes-2026-09-29-2342', 'nexrad-fixture.json'),
  'utf8',
);
const DOC = JSON.parse(FIXTURE);

// Fixture timestamps (from the live doc): KOKX lastScan 2026-09-30T03:43:01Z,
// TIDS 2026-09-30T03:42:55Z. nowMs picked so KOKX age = 600s (fresh),
// TIDS age = 606s (fresh).
const NOW_FRESH = Date.parse('2026-09-30T03:53:01+00:00');
const NOW_DARK = NOW_FRESH + 2 * 3600_000; // +2h: both exceed DARK_SEC

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

function fakeFetchOk(text) {
  return async () => ({
    ok: true,
    status: 200,
    headers: new Map([['content-length', String(text.length)]]),
    body: null,
    text: async () => text,
  });
}

test('numOrNull never yields 0 for null/NaN upstream numerics', () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(NaN), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull('987'), 987);
});

test('parseStationFeature maps a real WSR-88D feature', () => {
  const s = parseStationFeature(DOC.features[0], NOW_FRESH);
  assert.equal(s.id, 'KOKX');
  assert.equal(s.name, 'Brookhaven');
  assert.equal(s.type, 'WSR-88D');
  assert.ok(Math.abs(s.lat - 40.86552) < 1e-6);
  assert.ok(Math.abs(s.lon - -72.86392) < 1e-6);
  assert.equal(s.lastScan, '2026-09-30T03:43:01.000Z');
  // Independent age check: (03:53:01 − 03:43:01) = 600s, fresh (≤900), not dark
  assert.equal(s.ageSec, 600);
  assert.equal(s.fresh, true);
  assert.equal(s.dark, false);
  assert.equal(s.mode, 'Operational');
  assert.equal(s.status, 'Operate');
  assert.equal(s.vcp, 'R35');
  assert.equal(s.txPowerW, 987);
});

test('parseStationFeature honors the freshness boundary (900s) and dark threshold (3600s)', () => {
  const f = DOC.features[0];
  const at900 = parseStationFeature(f, Date.parse('2026-09-30T03:43:01+00:00') + 900_000);
  const at901 = parseStationFeature(f, Date.parse('2026-09-30T03:43:01+00:00') + 901_000);
  assert.equal(at900.ageSec, 900);
  assert.equal(at900.fresh, true); // boundary inclusive
  assert.equal(at901.ageSec, 901);
  assert.equal(at901.fresh, false);
  assert.equal(at901.dark, false); // stale but not dark
  const dark = parseStationFeature(f, Date.parse('2026-09-30T03:43:01+00:00') + (DARK_SEC + 1) * 1000);
  assert.equal(dark.dark, true);
  assert.equal(dark.fresh, false);
});

test('parseStationFeature treats missing latency as unknown, never zero', () => {
  const s = parseStationFeature(DOC.features[2], NOW_FRESH); // TLKA2 Profiler, latency:null
  assert.equal(s.id, 'TLKA2');
  assert.equal(s.lastScan, null);
  assert.equal(s.ageSec, null);
  assert.equal(s.fresh, false);
  assert.equal(s.dark, true); // unknown reads dark, honestly
});

test('parseStationFeature skips features with unplottable coords', () => {
  assert.equal(parseStationFeature(DOC.features[3], NOW_FRESH), null);
});

test('parseRadarStationsDoc summarizes 4 fixture features → 3 stations + 1 skipped', () => {
  const { stations, skipped, summary } = parseRadarStationsDoc(FIXTURE, NOW_FRESH);
  assert.equal(stations.length, 3);
  assert.equal(skipped, 1);
  assert.equal(summary.total, 3);
  assert.deepEqual(summary.byType, { 'WSR-88D': 1, TDWR: 1, Profiler: 1 });
  assert.equal(summary.fresh, 2); // KOKX + TIDS
  assert.equal(summary.dark, 1); // TLKA2 unknown
  assert.equal(summary.withScan, 2);
});

test('parseRadarStationsDoc throws 502 on non-JSON and empty features', () => {
  assert.throws(() => parseRadarStationsDoc('not json', NOW_FRESH), (e) => e.status === 502);
  assert.throws(
    () => parseRadarStationsDoc('{"type":"FeatureCollection","features":[]}', NOW_FRESH),
    (e) => e.status === 502,
  );
});

test('buildNexradPayload filters by type and station', () => {
  const parsed = parseRadarStationsDoc(FIXTURE, NOW_FRESH);
  const all = buildNexradPayload(parsed, { nowMs: NOW_FRESH, query: { type: null, station: null, key: ':' } });
  assert.equal(all.count, 3);
  assert.equal(all.requestedNotFound, false);
  const tdwr = buildNexradPayload(parsed, { nowMs: NOW_FRESH, query: { type: 'TDWR', station: null, key: 'TDWR:' } });
  assert.equal(tdwr.count, 1);
  assert.equal(tdwr.stations[0].id, 'TIDS');
  const one = buildNexradPayload(parsed, { nowMs: NOW_FRESH, query: { type: null, station: 'KOKX', key: ':KOKX' } });
  assert.equal(one.count, 1);
  assert.equal(one.stations[0].id, 'KOKX');
  const missing = buildNexradPayload(parsed, { nowMs: NOW_FRESH, query: { type: null, station: 'ZZZZ', key: ':ZZZZ' } });
  assert.equal(missing.count, 0);
  assert.equal(missing.requestedNotFound, true);
  assert.ok(all.attribution.includes('lastScan'));
});

test('nexradProxy mounts /api/nexrad on both server shapes', () => {
  const calls = mount(nexradProxy());
  assert.ok(calls.some((c) => c.route === '/api/nexrad'));
  assert.equal(calls.filter((c) => c.route === '/api/nexrad').length, 2);
});

test('nexradProxy 200s the fixture through the full handler path', async () => {
  clearCaches();
  const calls = mount(nexradProxy({ fetchImpl: fakeFetchOk(FIXTURE), now: () => NOW_FRESH }));
  const { handler } = calls[0];
  const res = fakeRes();
  await handler(fakeReq('/api/nexrad'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.stale, false);
  assert.equal(body.count, 3);
  assert.equal(body.summary.fresh, 2);
  assert.equal(body.stations[0].id, 'KOKX');
});

test('nexradProxy honors ?type= and ?station= through the handler path', async () => {
  clearCaches();
  const calls = mount(nexradProxy({ fetchImpl: fakeFetchOk(FIXTURE), now: () => NOW_FRESH }));
  const { handler } = calls[0];
  const res = fakeRes();
  await handler(fakeReq('/api/nexrad?type=tdwr'), res); // lowercase accepted
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.count, 1);
  assert.equal(body.stations[0].type, 'TDWR');
});

test('nexradProxy 400s bad type and malformed station id', async () => {
  clearCaches();
  const calls = mount(nexradProxy({ fetchImpl: fakeFetchOk(FIXTURE), now: () => NOW_FRESH }));
  const { handler } = calls[0];
  const r1 = fakeRes();
  await handler(fakeReq('/api/nexrad?type=bogus'), r1);
  assert.equal(r1.statusCode, 400);
  const r2 = fakeRes();
  await handler(fakeReq('/api/nexrad?station=!!!'), r2);
  assert.equal(r2.statusCode, 400);
});

test('success on one query key never blocks a different key (per-key retry gate)', async () => {
  clearCaches();
  const calls = mount(nexradProxy({ fetchImpl: fakeFetchOk(FIXTURE), now: () => NOW_FRESH }));
  const { handler } = calls[0];
  const r1 = fakeRes();
  await handler(fakeReq('/api/nexrad'), r1);
  assert.equal(r1.statusCode, 200);
  // Immediately, with a DIFFERENT key — the old global gate would 500 here.
  const r2 = fakeRes();
  await handler(fakeReq('/api/nexrad?type=WSR-88D'), r2);
  assert.equal(r2.statusCode, 200);
  assert.equal(JSON.parse(r2.body).count, 1);
});
test('filtered queries reuse the single doc fetch (1 upstream request per refresh)', async () => {
  clearCaches();
  let fetchCount = 0;
  const counting = async (...args) => {
    fetchCount++;
    return fakeFetchOk(FIXTURE)(...args);
  };
  const calls = mount(nexradProxy({ fetchImpl: counting, now: () => NOW_FRESH }));
  const { handler } = calls[0];
  for (const url of ['/api/nexrad', '/api/nexrad?type=TDWR', '/api/nexrad?station=KOKX']) {
    const res = fakeRes();
    await handler(fakeReq(url), res);
    assert.equal(res.statusCode, 200);
  }
  assert.equal(fetchCount, 1);
});

test('nexradProxy 502s (not 500) on network-level fetch failure', async () => {
  clearCaches();
  const calls = mount(
    nexradProxy({ fetchImpl: async () => { throw new TypeError('fetch failed'); }, now: () => NOW_FRESH }),
  );
  const { handler } = calls[0];
  const res = fakeRes();
  await handler(fakeReq('/api/nexrad'), res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'nexrad_unavailable');
});

test('nexradProxy 502s on upstream failure with no cache', async () => {
  clearCaches();
  const failing = async () => ({ ok: false, status: 503, headers: new Map(), body: null, text: async () => '' });
  const calls = mount(nexradProxy({ fetchImpl: failing, now: () => NOW_FRESH }));
  const { handler } = calls[0];
  const res = fakeRes();
  await handler(fakeReq('/api/nexrad'), res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'nexrad_unavailable');
});

test('nexradProxy serves stale:true from key-scoped cache on upstream failure', async () => {
  clearCaches();
  const calls = mount(nexradProxy({ fetchImpl: fakeFetchOk(FIXTURE), now: () => NOW_FRESH }));
  const { handler } = calls[0];
  const r1 = fakeRes();
  await handler(fakeReq('/api/nexrad'), r1);
  assert.equal(r1.statusCode, 200);
  const calls2 = mount(
    nexradProxy({
      fetchImpl: async () => { throw new Error('boom'); },
      now: () => NOW_FRESH + 300_000, // past TTL (120s), inside STALE (10min)
    }),
  );
  const r2 = fakeRes();
  await calls2[0].handler(fakeReq('/api/nexrad'), r2);
  assert.equal(r2.statusCode, 200);
  assert.equal(JSON.parse(r2.body).stale, true);
});
