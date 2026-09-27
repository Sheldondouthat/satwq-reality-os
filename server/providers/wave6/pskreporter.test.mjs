import assert from 'node:assert/strict';
import test from 'node:test';
import { pskreporterProxy, _pskreporterInternals } from './pskreporter.js';

const { gridToLatLon, parseReceptionReports, trimPskPayload, clearCaches } = _pskreporterInternals;

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
  return { method, url: '/api/pskreporter', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('pskreporterProxy mounts /api/pskreporter on both server shapes', () => {
  const routes = mount(pskreporterProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/pskreporter', '/api/pskreporter']);
});

test('gridToLatLon: FN31pr resolves to the known K1JT-ish square', () => {
  const p = gridToLatLon('FN31pr');
  assert.ok(p, 'expected a position');
  // FN31 spans lon -74..-72, lat 41..42; pr subsquare centers near (-72.71, 41.73).
  assert.ok(p.lon > -73 && p.lon < -72.5, `lon ${p.lon} out of range`);
  assert.ok(p.lat > 41.6 && p.lat < 41.9, `lat ${p.lat} out of range`);
});

test('gridToLatLon: 4-char grids center on the whole square', () => {
  const p = gridToLatLon('JO65');
  assert.ok(p);
  // JO65: field J → 0°, square 6 → +12° → center 13°E; field O → 50°, square 5 → center 55.5°N
  assert.equal(p.lon, 13);
  assert.equal(p.lat, 55.5);
});

test('gridToLatLon rejects garbage', () => {
  assert.equal(gridToLatLon(''), null);
  assert.equal(gridToLatLon('XX99'), null); // X is past the A–R field range
  assert.equal(gridToLatLon('ZZ99zz'), null);
  assert.equal(gridToLatLon(null), null);
  assert.equal(gridToLatLon(123), null);
});

const PSK_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<receptionReportList>
<receptionReport receiverCallsign="HB9DCO" receiverLocator="JN46la" senderCallsign="K1JT" senderLocator="FN31pr" frequencyHz="14074100" flowStartSeconds="1759000000" mode="FT8" sNR="-12"/>
<receptionReport receiverCallsign="W1XYZ" receiverLocator="" senderCallsign="K1JT" senderLocator="FN31pr" frequencyHz="14074100" flowStartSeconds="1759000001" mode="FT8" sNR="-9"/>
<receptionReport receiverCallsign="G4ABC" receiverLocator="IO91wm" senderCallsign="K1JT" senderLocator="" frequencyHz="21074100" flowStartSeconds="1759000002" mode="FT4" sNR="3"/>
</receptionReportList>`;

test('parseReceptionReports keeps valid reports, drops missing receiver locator', () => {
  const reports = parseReceptionReports(PSK_FIXTURE);
  assert.equal(reports.length, 2, 'one report lacked a receiver locator and must be dropped');
  const ft8 = reports.find((r) => r.receiver === 'HB9DCO');
  assert.ok(ft8);
  assert.equal(ft8.sender, 'K1JT');
  assert.equal(ft8.freqMHz, 14.0741);
  assert.equal(ft8.mode, 'FT8');
  assert.equal(ft8.snrDb, -12);
  assert.equal(ft8.time, new Date(1759000000 * 1000).toISOString());
  assert.ok(Number.isFinite(ft8.rxLat) && Number.isFinite(ft8.rxLon));
  assert.ok(Number.isFinite(ft8.txLat) && Number.isFinite(ft8.txLon));
  // Missing sender locator → nulls, but the report survives.
  const ft4 = reports.find((r) => r.receiver === 'G4ABC');
  assert.ok(ft4);
  assert.equal(ft4.txLat, null);
  assert.equal(ft4.freqMHz, 21.0741);
});

test('trimPskPayload wraps reports with metadata', () => {
  const payload = trimPskPayload(PSK_FIXTURE);
  assert.equal(payload.count, 2);
  assert.equal(payload.windowSec, 3600);
  assert.ok(Date.parse(payload.generatedAt) > 0);
  assert.equal(payload.reports.length, 2);
});

test('handler returns 405 for non-GET', async () => {
  clearCaches();
  const [{ handler }] = mount(pskreporterProxy());
  const res = fakeRes();
  await handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});

test('handler returns 502 JSON when the upstream is down', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const [{ handler }] = mount(pskreporterProxy());
    const res = fakeRes();
    await handler(fakeReq('GET'), res);
    assert.equal(res.statusCode, 502);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'pskreporter_unavailable');
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler serves parsed fixture on 200 and caches it', async () => {
  clearCaches();
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    return new Response(PSK_FIXTURE, { status: 200, headers: { 'Content-Type': 'application/xml' } });
  };
  try {
    const [{ handler }] = mount(pskreporterProxy());
    const res1 = fakeRes();
    await handler(fakeReq('GET'), res1);
    assert.equal(res1.statusCode, 200);
    const body1 = JSON.parse(res1.body);
    assert.equal(body1.count, 2);
    const res2 = fakeRes();
    await handler(fakeReq('GET'), res2);
    assert.equal(fetchCalls, 1, 'second request must come from the TTL cache');
    assert.equal(JSON.parse(res2.body).count, 2);
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
