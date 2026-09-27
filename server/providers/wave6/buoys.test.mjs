import assert from 'node:assert/strict';
import test from 'node:test';
import { buoysProxy, _buoysInternals } from './buoys.js';

const { parseBuoyRow, trimBuoyPayload, numOrNull, clampLimit, clearCaches } = _buoysInternals;

// Fixtures are REAL rows captured live from the NDBC feed on 2026-09-27
// (curl https://www.ndbc.noaa.gov/data/latest_obs/latest_obs.txt, HTTP 200).
// Field order: STN LAT LON YYYY MM DD hh mn WDIR WSPD GST WVHT DPD APD MWD
// PRES PTDY ATMP WTMP DEWP VIS TIDE; 'MM' = missing.
const HEADER_1 = '#STN       LAT      LON  YYYY MM DD hh mm WDIR WSPD   GST WVHT  DPD APD MWD   PRES  PTDY  ATMP  WTMP  DEWP  VIS   TIDE';
const HEADER_2 = '#text      deg      deg   yr mo day hr mn degT  m/s   m/s   m   sec sec degT   hPa   hPa  degC  degC  degC  nmi     ft';
const ROW_FULL = '44080    39.223  -76.528 2026 09 27 20 36 340  12.0  14.0  0.4   2   MM  MM 1007.1    MM  18.1  22.6    MM   MM     MM';
const ROW_ATM = '14049   -12.000   65.000 2026 09 27 19 00  99   8.2  10.5   MM  MM   MM  MM 1016.4    MM  21.0  26.8    MM   MM     MM';
const ROW_VIS = '62107    50.102   -6.100 2026 09 27 20 00  MM    MM    MM  2.3  MM   MM  MM 1016.9    MM  16.6  16.9  10.8   11     MM';

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

test('numOrNull treats MM, empty and junk as null', () => {
  assert.equal(numOrNull('MM'), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull('8.2'), 8.2);
  assert.equal(numOrNull('+0.6'), 0.6);
  assert.equal(numOrNull('-12.000'), -12);
});

test('parseBuoyRow maps a fully-populated moored-buoy row', () => {
  const b = parseBuoyRow(ROW_FULL.split(/\s+/));
  assert.equal(b.id, '44080');
  assert.equal(b.lat, 39.223);
  assert.equal(b.lon, -76.528);
  assert.equal(b.time, '2026-09-27T20:36:00.000Z');
  assert.equal(b.windDirDeg, 340);
  assert.equal(b.windSpeedMps, 12);
  assert.equal(b.gustMps, 14);
  assert.equal(b.waveHeightM, 0.4);
  assert.equal(b.wavePeriodSec, 2);
  assert.equal(b.waveDirDeg, null); // MWD was MM
  assert.equal(b.presHpa, 1007.1);
  assert.equal(b.airTempC, 18.1);
  assert.equal(b.waterTempC, 22.6);
  assert.equal(b.tideFt, null);
});

test('parseBuoyRow maps an atmosphere-only row (drifting buoy)', () => {
  const b = parseBuoyRow(ROW_ATM.split(/\s+/));
  assert.equal(b.id, '14049');
  assert.equal(b.lat, -12);
  assert.equal(b.lon, 65);
  assert.equal(b.waveHeightM, null);
  assert.equal(b.presHpa, 1016.4);
  assert.equal(b.airTempC, 21);
  assert.equal(b.waterTempC, 26.8);
});

test('parseBuoyRow maps dew point and visibility columns', () => {
  const b = parseBuoyRow(ROW_VIS.split(/\s+/));
  assert.equal(b.id, '62107');
  assert.equal(b.windDirDeg, null); // WDIR was MM
  assert.equal(b.waveHeightM, 2.3);
  assert.equal(b.dewPointC, 10.8);
  assert.equal(b.visNmi, 11);
});

test('parseBuoyRow rejects short rows and bad coordinates', () => {
  assert.equal(parseBuoyRow(['44080', '39.223']), null);
  assert.equal(parseBuoyRow(['X', 'MM', 'MM', '2026', '09', '27', '20', '36']), null);
  assert.equal(parseBuoyRow(null), null);
});

test('trimBuoyPayload skips header lines and respects limit', () => {
  const text = [HEADER_1, HEADER_2, ROW_FULL, ROW_ATM, ROW_VIS].join('\n');
  const p = trimBuoyPayload(text, 2);
  assert.equal(p.count, 2);
  assert.equal(p.buoys[0].id, '44080');
  assert.equal(p.buoys[1].id, '14049');
  assert.ok(p.generatedAt);
  assert.ok(p.source.includes('NDBC'));
});

test('clampLimit clamps and defaults', () => {
  assert.equal(clampLimit('10'), 10);
  assert.equal(clampLimit(null), 500);
  assert.equal(clampLimit('0'), 1); // finite input clamps, not defaulted
  assert.equal(clampLimit('99999'), 2000);
  assert.equal(clampLimit('abc'), 500);
});

test('provider mounts /api/buoys on both servers and rejects non-GET', async () => {
  const calls = mount(buoysProxy());
  assert.ok(calls.some((c) => c.route === '/api/buoys'));
  const { handler } = calls[0];
  const res = fakeRes();
  await handler(fakeReq('/api/buoys', 'POST'), res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});

test('handler returns 200 JSON on live-shaped text', async () => {
  const realFetch = globalThis.fetch;
  const body = [HEADER_1, HEADER_2, ROW_FULL].join('\n');
  globalThis.fetch = async () => new Response(body, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  try {
    clearCaches();
    const { handler } = mount(buoysProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/buoys?limit=10'), res);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.count, 1);
    assert.equal(parsed.buoys[0].id, '44080');
    assert.equal(parsed.buoys[0].lat, 39.223);
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});

test('handler returns 502 JSON when upstream is down', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    clearCaches();
    const { handler } = mount(buoysProxy())[0];
    const res = fakeRes();
    await handler(fakeReq('/api/buoys'), res);
    assert.equal(res.statusCode, 502);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.error, 'buoys_unavailable');
    assert.ok(res.headers['Cache-Control'].includes('no-store'));
  } finally {
    globalThis.fetch = realFetch;
    clearCaches();
  }
});
