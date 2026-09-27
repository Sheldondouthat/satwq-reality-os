/**
 * IOC sea-level provider + frontend data-client tests.
 * All upstream I/O is stubbed — no network. Fixtures mirror the real IOC
 * legacy service.php shapes captured 2026-09-27.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  iocSealevelProxy,
  stratifyStations,
  trendPerHour,
  normalizeStation,
} from '../../../../server/providers/wave3/iocSealevel.js';
import { createSealevelSource } from './source.js';
import { init } from './index.js';

const STATION_LIST = [
  { code: 'aarh', Location: 'Aarhus', country: 'DMK', type: 'SF', Lat: 56.15, Lon: 10.22, status: 1, statday: '2026-09-26 05:16:00' },
  { code: 'abas', Location: 'Abashiri', country: 'JPN', type: 'SL', Lat: 44.02, Lon: 144.29, status: 1, statday: '2026-09-26 05:16:00' },
  { code: 'abed', Location: 'Aberdeen', country: 'GBR', type: 'SF', Lat: 57.14, Lon: -2.08, status: 1, statday: '2026-09-26 05:15:00' },
  { code: 'dead', Location: 'Dead', country: 'XXX', type: 'SL', Lat: 0, Lon: 0, status: 0, statday: null },
  { code: 'nolat', Location: 'NoLat', country: 'XXX', type: 'SL', Lat: null, Lon: 0, status: 1, statday: null },
];

const OBS = [
  { slevel: 0.27, stime: '2026-09-26 12:10:00', sensor: 'rad' },
  { slevel: 0.25, stime: '2026-09-26 12:20:00', sensor: 'rad' },
  { slevel: 0.25, stime: '2026-09-26 12:30:00', sensor: 'rad' },
  { slevel: 0.22, stime: '2026-09-26 12:40:00', sensor: 'rad' },
  { slevel: 0.22, stime: '2026-09-26 12:50:00', sensor: 'rad' },
  { slevel: 0.2, stime: '2026-09-26 13:00:00', sensor: 'rad' },
  { slevel: 'junk', stime: '2026-09-26 13:10:00', sensor: 'rad' },
];

function fakeReq(url, method = 'GET') {
  return { method, url, on() {}, removeListener() {}, headers: {} };
}

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers;
    },
    end(body) {
      chunks.push(body);
      res.body = chunks.join('');
    },
  };
  return res;
}

/** Stub fetch routing stationlist vs per-station data. */
function stubIoc({ failDataFor = new Set(), seen = null } = {}) {
  return async (url) => {
    seen?.push(url);
    if (url.includes('query=stationlist')) {
      return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(STATION_LIST) };
    }
    const m = url.match(/code=([^&]+)/);
    const code = m ? decodeURIComponent(m[1]) : '';
    if (failDataFor.has(code)) throw new Error('gauge down');
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(OBS) };
  };
}

async function callHandler(provider, url, method = 'GET') {
  const calls = [];
  const middlewares = { use: (route, handler) => calls.push({ route, handler }) };
  provider.configureServer({ middlewares });
  const res = fakeRes();
  await calls[0].handler(fakeReq(url, method), res);
  return res;
}

// — provider shape -------------------------------------------------------

test('iocSealevelProxy mounts /api/sealevel on both server shapes', () => {
  const provider = iocSealevelProxy();
  assert.equal(provider.name, 'ioc-sealevel');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/sealevel', '/api/sealevel']);
});

test('iocSealevelProxy rejects non-GET with 405', async () => {
  const res = await callHandler(iocSealevelProxy(), '/api/sealevel', 'POST');
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /method_not_allowed/);
});

// — stratification --------------------------------------------------------

test('stratifyStations picks one live station per cell, skips dead/latlon-less', () => {
  const picked = stratifyStations(STATION_LIST, 24);
  const codes = picked.map((s) => s.code);
  assert.ok(codes.includes('aarh'));
  assert.ok(codes.includes('abas'));
  assert.ok(!codes.includes('dead'));
  assert.ok(!codes.includes('nolat'));
  assert.equal(picked.length, 3);
});

test('stratifyStations prefers the most recently reporting station per cell', () => {
  const list = [
    { code: 'old', Lat: 10, Lon: 10, status: 1, statday: '2026-09-20 00:00:00' },
    { code: 'new', Lat: 11, Lon: 11, status: 1, statday: '2026-09-26 00:00:00' },
  ];
  const picked = stratifyStations(list);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].code, 'new');
});

// — trend ------------------------------------------------------------------

test('trendPerHour computes a negative slope for falling levels', () => {
  const slope = trendPerHour(OBS);
  // falls 0.07 m over 50 min → about −0.084 m/h
  assert.ok(slope !== null && slope < 0, `slope=${slope}`);
  assert.ok(Math.abs(slope + 0.084) < 0.02, `slope=${slope}`);
});

test('trendPerHour returns null with too few points', () => {
  assert.equal(trendPerHour(OBS.slice(0, 2)), null);
  assert.equal(trendPerHour([]), null);
});

// — normalization -----------------------------------------------------------

test('normalizeStation builds the contract row, skips junk levels', () => {
  const row = normalizeStation(STATION_LIST[0], OBS);
  assert.equal(row.code, 'aarh');
  assert.equal(row.location, 'Aarhus');
  assert.equal(row.lat, 56.15);
  assert.equal(row.lon, 10.22);
  assert.equal(row.samples, 6); // junk row dropped
  assert.equal(row.latest.level, 0.2);
  assert.match(row.latest.t, /^2026-09-26T13:00:00/);
  assert.ok(row.trendMPerH < 0);
  assert.equal(row.status, 'ok');
});

test('normalizeStation marks empty observations nodata', () => {
  const row = normalizeStation(STATION_LIST[0], []);
  assert.equal(row.status, 'nodata');
  assert.equal(row.latest, null);
});

// — handler end-to-end (stubbed IOC) ------------------------------------------

test('handler returns stratified snapshot from stubbed IOC', async () => {
  const provider = iocSealevelProxy({ fetchImpl: stubIoc() });
  const res = await callHandler(provider, '/api/sealevel');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.selection, 'stratified');
  assert.equal(body.stations.length, 3);
  const aarh = body.stations.find((s) => s.code === 'aarh');
  assert.equal(aarh.status, 'ok');
  assert.equal(aarh.latest.level, 0.2);
});

test('handler honors ?stations= custom selection', async () => {
  const provider = iocSealevelProxy({ fetchImpl: stubIoc() });
  const res = await callHandler(provider, '/api/sealevel?stations=aarh,abas');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.selection, 'custom');
  assert.deepEqual(body.stations.map((s) => s.code), ['aarh', 'abas']);
});

test('handler rejects malformed station codes with 400', async () => {
  const provider = iocSealevelProxy({ fetchImpl: stubIoc() });
  const res = await callHandler(provider, '/api/sealevel?stations=!!!');
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /sealevel_bad_station_codes/);
});

test('handler marks one dead gauge as error, keeps the rest', async () => {
  const provider = iocSealevelProxy({ fetchImpl: stubIoc({ failDataFor: new Set(['aarh']) }) });
  const res = await callHandler(provider, '/api/sealevel');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.stations.find((s) => s.code === 'aarh').status, 'error');
  assert.equal(body.stations.filter((s) => s.status === 'ok').length, 2);
});

test('handler returns 502 when the station list fails with no cache', async () => {
  const provider = iocSealevelProxy({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  const res = await callHandler(provider, '/api/sealevel');
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /sealevel_upstream_unavailable/);
});

// — frontend data client ------------------------------------------------------

test('createSealevelSource refresh stores snapshot, fail-soft on error', async () => {
  const payload = { fetchedAt: 1, stations: [] };
  const source = createSealevelSource({
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const good = await source.refresh();
  assert.equal(good.ok, true);
  assert.deepEqual(source.getSnapshot(), payload);
});

test('init never throws and returns a working handle', async () => {
  const handle = init({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
    refreshMs: 30,
  });
  assert.ok(handle && typeof handle.stop === 'function');
  handle.stop();
  const broken = init({ fetchImpl: null });
  assert.equal(broken.getSnapshot(), null);
  broken.stop();
});
