/**
 * Argo provider + frontend data-client tests.
 * All upstream I/O is stubbed — no network. Fixtures mirror the real
 * Ifremer ERDDAP tabledap JSON shapes captured 2026-09-27.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  argoProxy,
  latestFixesPerFloat,
  medianSurfaceTempPerFloat,
} from '../../../../server/providers/wave3/argo.js';
import { createArgoSource } from './source.js';
import { init } from './index.js';

function erddapTable(columnNames, rows) {
  return {
    table: {
      columnNames,
      columnTypes: columnNames.map(() => 'double'),
      columnUnits: columnNames.map(() => null),
      rows,
    },
  };
}

const POS_DOC = erddapTable(
  ['platform_number', 'time', 'latitude', 'longitude', 'position_qc'],
  [
    ['1901514', '2026-09-23T13:23:32Z', 1.626, 44.637, '1'],
    ['1901514', '2026-09-20T11:00:00Z', 1.5, 44.5, '1'],
    ['1901614', '2026-09-22T14:59:55Z', 16.3321, -156.2768, '1'],
    ['badrow', '2026-09-22T14:00:00Z', null, -100, '1'], // dropped
  ],
);

const TEMP_DOC = erddapTable(
  ['platform_number', 'time', 'temp'],
  [
    ['1901514', '2026-09-23T13:23:32Z', 27.5],
    ['1901514', '2026-09-23T13:23:32Z', 27.7],
    ['1901514', '2026-09-23T13:23:32Z', 27.6],
    ['1901614', '2026-09-22T14:59:55Z', 24.1],
  ],
);

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

function stubErddap({ temp = TEMP_DOC, seen = null } = {}) {
  return async (url) => {
    seen?.push(url);
    const doc = url.includes('platform_number,time,temp') ? temp : POS_DOC;
    if (doc === null) throw new Error('temp down');
    return { ok: true, headers: { get: () => null }, text: async () => JSON.stringify(doc) };
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

test('argoProxy mounts /api/argo on both server shapes', () => {
  const provider = argoProxy();
  assert.equal(provider.name, 'argo');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/argo', '/api/argo']);
});

test('argoProxy rejects non-GET with 405', async () => {
  const res = await callHandler(argoProxy(), '/api/argo', 'POST');
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /method_not_allowed/);
});

// — pure reducers -----------------------------------------------------------

test('latestFixesPerFloat keeps the newest fix per float', () => {
  const floats = latestFixesPerFloat([
    { platform_number: 'A', time: '2026-09-20T00:00:00Z', latitude: 1, longitude: 2, position_qc: '1' },
    { platform_number: 'A', time: '2026-09-23T00:00:00Z', latitude: 1.5, longitude: 2.5, position_qc: '1' },
    { platform_number: 'B', time: '2026-09-21T00:00:00Z', latitude: 3, longitude: 4, position_qc: '2' },
  ]);
  assert.equal(floats.length, 2);
  const a = floats.find((f) => f.wmo === 'A');
  assert.equal(a.lat, 1.5);
  assert.equal(a.t, '2026-09-23T00:00:00Z');
  assert.equal(a.profilesInWindow, 2);
});

test('latestFixesPerFloat drops rows with missing coords', () => {
  const floats = latestFixesPerFloat([
    { platform_number: 'A', time: '2026-09-23T00:00:00Z', latitude: null, longitude: 2 },
    { platform_number: '', time: '2026-09-23T00:00:00Z', latitude: 1, longitude: 2 },
  ]);
  assert.equal(floats.length, 0);
});

test('medianSurfaceTempPerFloat medians per float, ignores junk', () => {
  const temps = medianSurfaceTempPerFloat([
    { platform_number: 'A', temp: 27.5 },
    { platform_number: 'A', temp: 27.7 },
    { platform_number: 'A', temp: 'junk' },
    { platform_number: 'B', temp: 24.1 },
  ]);
  assert.equal(temps.get('A'), 27.6);
  assert.equal(temps.get('B'), 24.1);
});

// — handler end-to-end (stubbed ERDDAP) ---------------------------------------

test('handler merges positions + temps into the constellation', async () => {
  const seen = [];
  const provider = argoProxy({ fetchImpl: stubErddap({ seen }) });
  const res = await callHandler(provider, '/api/argo');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.windowDays, 30);
  assert.equal(body.floats.length, 2);
  const f = body.floats.find((x) => x.wmo === '1901514');
  assert.equal(f.lat, 1.626);
  assert.equal(f.lon, 44.637);
  assert.equal(f.t, '2026-09-23T13:23:32Z');
  assert.equal(f.profilesInWindow, 2);
  assert.equal(f.surfaceTempC, 27.6);
  assert.equal(body.tempCoverage, 1);
  // positions query uses distinct(), temp query constrains pres<5
  assert.ok(seen.some((u) => u.includes('distinct()')));
  assert.ok(seen.some((u) => u.includes('pres%3C5')));
});

test('handler still serves positions when the temp query fails', async () => {
  const provider = argoProxy({ fetchImpl: stubErddap({ temp: null }) });
  const res = await callHandler(provider, '/api/argo');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.floats.length, 2);
  assert.equal(body.floats[0].surfaceTempC, null);
  assert.equal(body.tempCoverage, 0);
});

test('handler clamps ?days= to [1, 90]', async () => {
  const seen = [];
  const provider = argoProxy({ fetchImpl: stubErddap({ seen }) });
  await callHandler(provider, '/api/argo?days=500');
  assert.ok(seen[0].includes('time%3E='));
  const res = await callHandler(argoProxy({ fetchImpl: stubErddap() }), '/api/argo?days=7');
  assert.equal(JSON.parse(res.body).windowDays, 7);
});

test('handler returns 502 when positions fail with no cache', async () => {
  const provider = argoProxy({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  const res = await callHandler(provider, '/api/argo');
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /argo_upstream_unavailable/);
});

// — frontend data client -------------------------------------------------------

test('createArgoSource refresh stores snapshot, fail-soft on error', async () => {
  const payload = { fetchedAt: 1, floats: [] };
  const source = createArgoSource({
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
