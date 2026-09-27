import assert from 'node:assert/strict';
import test from 'node:test';
import { geomagUsgsProxy, _geomagUsgsInternals } from './geomagUsgs.js';

const { parseIaga2002, deriveHD, buildGeomagPayload, buildDataUrl, OBSERVATORIES, clearCaches } =
  _geomagUsgsInternals;

// LIVE CAPTURE — fetched 2026-09-27 from the build VM (HTTP 200 from
// https://geomag.usgs.gov/ws/data/?id=BOU&…&format=iaga2002).
// Genuine USGS IAGA-2002 response, trimmed to 6 data rows; the last row is
// the 99999.00 missing-data sentinel, exactly as the upstream emits it.
const LIVE_CAPTURE = [
  ' Format                 IAGA-2002                                    |',
  ' Source of Data         United States Geological Survey (USGS)       |',
  ' Station Name           Boulder                                      |',
  ' IAGA CODE              BOU                                          |',
  ' Geodetic Latitude      40.137                                       |',
  ' Geodetic Longitude     -105.237                                     |',
  ' Elevation              1682                                         |',
  ' Reported               XYZF                                         |',
  ' Sensor Orientation     HDZ                                          |',
  ' Digital Sampling       0.01 second                                  |',
  ' Data Interval Type     1-minute                                     |',
  ' Data Type              adjusted                                     |',
  'DATE       TIME         DOY     BOUX      BOUY      BOUZ      BOUF   |',
  '2026-09-27 19:39:00.000 270     20475.82   2777.15  46627.16  51000.56',
  '2026-09-27 19:40:00.000 270     20475.59   2777.14  46627.30  51000.62',
  '2026-09-27 19:41:00.000 270     20475.77   2776.99  46627.47  51000.84',
  '2026-09-27 19:42:00.000 270     20475.92   2776.86  46627.68  51001.08',
  '2026-09-27 19:43:00.000 270     20475.99   2776.77  46627.83  51001.25',
  '2026-09-27 21:39:00.000 270     99999.00  99999.00  99999.00  99999.00',
].join('\n');

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

test('geomagUsgsProxy mounts /api/geomag-usgs on both server shapes', () => {
  const routes = mount(geomagUsgsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/geomag-usgs', '/api/geomag-usgs']);
});

test('parseIaga2002 parses the live capture header and rows', () => {
  const p = parseIaga2002(LIVE_CAPTURE);
  assert.equal(p.meta.stationName, 'Boulder');
  assert.equal(p.meta.iagaCode, 'BOU');
  assert.equal(p.meta.lat, 40.137);
  assert.equal(p.meta.lon, -105.237);
  assert.equal(p.meta.reported, 'XYZF');
  assert.equal(p.meta.dataType, 'adjusted');
  assert.deepEqual(p.compNames, ['BOUX', 'BOUY', 'BOUZ', 'BOUF']);
  assert.equal(p.series.length, 6);
  assert.equal(p.series[0].t, '2026-09-27T19:39:00.000Z');
  assert.equal(p.series[0].x, 20475.82);
  assert.equal(p.series[0].f, 51000.56);
  // the sentinel row becomes nulls, not numbers
  assert.equal(p.series[5].x, null);
  assert.equal(p.series[5].y, null);
  assert.equal(p.series[5].z, null);
  assert.equal(p.series[5].f, null);
});

test('parseIaga2002 treats 88888.00 spike flags as missing', () => {
  const text = LIVE_CAPTURE.replace('20475.82', '88888.00');
  const p = parseIaga2002(text);
  assert.equal(p.series[0].x, null);
  assert.equal(p.series[0].y, 2777.15);
});

test('parseIaga2002 rejects garbage', () => {
  assert.throws(() => parseIaga2002('hello world'), /geomag_iaga_invalid/);
  assert.throws(() => parseIaga2002('DATE TIME DOY A B C D\n'), /geomag_iaga_invalid/);
});

test('deriveHD computes horizontal intensity and declination', () => {
  const { h, d } = deriveHD(20475.82, 2777.15);
  assert.ok(Math.abs(h - Math.hypot(20475.82, 2777.15)) < 0.01);
  assert.ok(Math.abs(d - (Math.atan2(2777.15, 20475.82) * 180) / Math.PI) < 0.01);
  assert.deepEqual(deriveHD(null, 1), { h: null, d: null });
});

test('buildGeomagPayload separates latest row from latest VALID sample', () => {
  const parsed = parseIaga2002(LIVE_CAPTURE);
  const payload = buildGeomagPayload(parsed, { id: 'BOU', hours: 3, nowMs: 1_000_000 });
  assert.equal(payload.stale, false);
  assert.ok(payload.generatedAt);
  assert.equal(payload.observatory.id, 'BOU');
  assert.equal(payload.observatory.name, 'Boulder');
  assert.equal(payload.window.rows, 6);
  // the most recent ROW is the sentinel row…
  assert.equal(payload.latest.x, null);
  assert.equal(payload.latest.valid, false);
  // …but latestValid points at the real 19:43 sample with derived H/D
  assert.equal(payload.latestValid.t, '2026-09-27T19:43:00.000Z');
  assert.equal(payload.latestValid.x, 20475.99);
  assert.ok(Number.isFinite(payload.latestValid.h));
  assert.ok(Number.isFinite(payload.latestValid.d));
  // stats skip nulls: 5 valid rows for x
  assert.equal(payload.stats.x.validCount, 5);
  assert.ok(payload.stats.x.min < payload.stats.x.max);
  assert.match(payload.derivedNote, /declination/);
  assert.match(payload.attribution, /U\.S\. Geological Survey/);
});

test('buildDataUrl requests iaga2002 over the requested window', () => {
  const url = buildDataUrl({ id: 'SIT', hours: 3, endMs: Date.parse('2026-09-27T22:00:00Z') });
  assert.match(url, /^https:\/\/geomag\.usgs\.gov\/ws\/data\/\?/);
  assert.match(url, /id=SIT/);
  assert.match(url, /format=iaga2002/);
  assert.match(url, /starttime=2026-09-27T19%3A00%3A00Z/);
  assert.match(url, /endtime=2026-09-27T22%3A00%3A00Z/);
});

test('handler 400s on unknown observatory id and bad hours', async () => {
  clearCaches();
  const provider = geomagUsgsProxy({ fetchImpl: async () => { throw new Error('should not fetch'); } });
  const { handler } = mount(provider)[0];
  const res1 = fakeRes();
  await handler(fakeReq('/api/geomag-usgs?id=XXXX'), res1);
  assert.equal(res1.statusCode, 400);
  const res2 = fakeRes();
  await handler(fakeReq('/api/geomag-usgs?hours=99'), res2);
  assert.equal(res2.statusCode, 400);
});

test('handler serves parsed geomag from a stubbed fetch', async () => {
  clearCaches();
  const stub = async () => new Response(LIVE_CAPTURE, { status: 200, headers: { 'content-type': 'text/plain' } });
  const provider = geomagUsgsProxy({ fetchImpl: stub, now: () => 1_000_000 });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler(fakeReq('/api/geomag-usgs'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.observatory.id, 'BOU');
  assert.equal(body.latestValid.x, 20475.99);
  assert.equal(body.stale, false);
});

test('handler returns honest 502 when upstream is down', async () => {
  clearCaches();
  const stub = async () => new Response('service unavailable', { status: 503 });
  const provider = geomagUsgsProxy({ fetchImpl: stub, now: () => 2_000_000 });
  const { handler } = mount(provider)[0];
  const res = fakeRes();
  await handler(fakeReq('/api/geomag-usgs'), res);
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'geomag_unavailable');
  assert.match(body.detail, /geomag_upstream_503/);
});

test('handler serves stale cache when upstream fails', async () => {
  clearCaches();
  const good = async () => new Response(LIVE_CAPTURE, { status: 200 });
  const provider = geomagUsgsProxy({ fetchImpl: good, now: () => 3_000_000 });
  const first = fakeRes();
  await mount(provider)[0].handler(fakeReq('/api/geomag-usgs'), first);
  assert.equal(first.statusCode, 200);
  const bad = async () => { throw Object.assign(new Error('boom'), { status: 502 }); };
  const provider2 = geomagUsgsProxy({ fetchImpl: bad, now: () => 3_000_000 + 6 * 60_000 });
  const res = fakeRes();
  await mount(provider2)[0].handler(fakeReq('/api/geomag-usgs'), res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.stale, true);
  assert.equal(body.observatory.id, 'BOU');
});

test('OBSERVATORIES allowlist holds only live-verified USGS codes', () => {
  const codes = Object.keys(OBSERVATORIES);
  assert.ok(codes.includes('BOU') && codes.includes('SIT') && codes.includes('DED'));
  assert.ok(!codes.includes('XXXX'));
  assert.equal(codes.length, 12);
});

test('stale fallback never serves a cache entry from a different query', async () => {
  clearCaches();
  const good = async () => new Response(LIVE_CAPTURE, { status: 200 });
  const provider = geomagUsgsProxy({ fetchImpl: good, now: () => 4_000_000 });
  const first = fakeRes();
  await mount(provider)[0].handler(fakeReq('/api/geomag-usgs?id=BOU'), first);
  assert.equal(first.statusCode, 200);
  // A different observatory id fails upstream: must 502, not serve BOU's cache.
  const bad = async () => { throw Object.assign(new Error('boom'), { status: 502 }); };
  const provider2 = geomagUsgsProxy({ fetchImpl: bad, now: () => 4_000_000 + 90_000 });
  const res = fakeRes();
  await mount(provider2)[0].handler(fakeReq('/api/geomag-usgs?id=SIT'), res);
  assert.equal(res.statusCode, 502);
  const body = JSON.parse(res.body);
  assert.equal(body.error, 'geomag_unavailable');
});
