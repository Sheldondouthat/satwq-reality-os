/**
 * INTERMAGNET provider + frontend data-client tests.
 * All upstream I/O is stubbed — no network. Fixtures mirror the real HAPI
 * 3.1 envelopes captured 2026-09-27 (status code 1200, [Time, Field_Magnitude]
 * rows).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  intermagnetProxy,
  hapiOk,
  normalizeObservatory,
} from '../../../../server/providers/wave3/intermagnet.js';
import { createGeomagSource } from './source.js';
import { init } from './index.js';

const OTT = { code: 'ott', name: 'Ottawa', lat: 45.403, lon: -75.552 };

const INFO_OK = {
  HAPI: '3.1',
  status: { code: 1200, message: 'ok' },
  startDate: '1991-01-01T00:00:00Z',
  stopDate: '2026-09-26T05:55:00Z',
  parameters: [
    { name: 'Time', units: 'UTC' },
    { name: 'Field_Magnitude', units: 'nT' },
  ],
};

const DATA_OK = {
  HAPI: '3.1',
  status: { code: 1200, message: 'ok' },
  parameters: [{ name: 'Time' }, { name: 'Field_Magnitude' }],
  data: [
    ['2026-09-26T05:50Z', 53410.6094],
    ['2026-09-26T05:51Z', 53409.5703],
    ['2026-09-26T05:52Z', 53409.4297],
    ['2026-09-26T05:53Z', 53411.8008],
    ['2026-09-26T05:54Z', 53412.6914],
    ['2026-09-26T05:55Z', 53415.0],
  ],
};

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

/** Stub fetch routing /info → INFO_OK, /data → DATA_OK (or per-url overrides). */
function stubHapi({ info = INFO_OK, data = DATA_OK, seen = null } = {}) {
  return async (url) => {
    seen?.push(url);
    const doc = url.includes('/info?') ? info : data;
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

test('intermagnetProxy mounts /api/geomag on both server shapes', () => {
  const provider = intermagnetProxy();
  assert.equal(provider.name, 'intermagnet');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/geomag', '/api/geomag']);
});

test('intermagnetProxy rejects non-GET with 405', async () => {
  const res = await callHandler(intermagnetProxy(), '/api/geomag', 'POST');
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /method_not_allowed/);
});

// — HAPI helpers ----------------------------------------------------------

test('hapiOk accepts only code 1200 envelopes', () => {
  assert.equal(hapiOk({ status: { code: 1200 } }), true);
  assert.equal(hapiOk({ status: { code: 1400, message: 'x' } }), false);
  assert.equal(hapiOk(null), false);
  assert.equal(hapiOk({}), false);
});

test('normalizeObservatory computes medianF + anomalyNT', () => {
  const row = normalizeObservatory(OTT, DATA_OK.data);
  assert.equal(row.code, 'OTT');
  assert.equal(row.name, 'Ottawa');
  assert.equal(row.lat, 45.403);
  assert.equal(row.dataset, 'ott/best-avail/PT1M/xyzf');
  // sorted F: 53409.4297, 53409.5703, 53410.6094, 53411.8008, 53412.6914, 53415
  // median = (53410.6094 + 53411.8008)/2 = 53411.2051
  assert.ok(Math.abs(row.medianF - 53411.2051) < 0.01, `medianF=${row.medianF}`);
  assert.deepEqual(row.latest, { t: '2026-09-26T05:55Z', f: 53415 });
  assert.ok(Math.abs(row.anomalyNT - (53415 - 53411.2051)) < 0.01);
  assert.equal(row.samples, 6);
  assert.equal(row.status, 'ok');
});

test('normalizeObservatory skips non-finite rows, nodata when empty', () => {
  const row = normalizeObservatory(OTT, [['2026-09-26T05:55Z', null], ['x']]);
  assert.equal(row.status, 'nodata');
  assert.equal(row.latest, null);
});

// — handler end-to-end (stubbed HAPI) ---------------------------------------

test('handler builds snapshot from stubbed HAPI for all observatories', async () => {
  const seen = [];
  const provider = intermagnetProxy({ fetchImpl: stubHapi({ seen }) });
  const res = await callHandler(provider, '/api/geomag');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.windowMin, 120);
  assert.equal(body.observatories.length, 8);
  const ott = body.observatories.find((o) => o.code === 'OTT');
  assert.equal(ott.status, 'ok');
  assert.equal(ott.latest.f, 53415);
  assert.ok(ott.anomalyNT !== null);
  // the data window must end at the /info stopDate
  const dataUrl = seen.find((u) => u.includes('/data?') && u.includes('dataset=ott'));
  assert.match(dataUrl, /stop=2026-09-26T05%3A55%3A00Z/);
});

test('handler marks one dead observatory as error, keeps the rest', async () => {
  const provider = intermagnetProxy({
    fetchImpl: async (url) => {
      if (url.includes('dataset=ott%2F')) throw new Error('down');
      return stubHapi()(url);
    },
  });
  const res = await callHandler(provider, '/api/geomag');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.observatories.find((o) => o.code === 'OTT').status, 'error');
  assert.equal(body.observatories.filter((o) => o.status === 'ok').length, 7);
});

test('handler returns 502 when every observatory fails with no cache', async () => {
  const provider = intermagnetProxy({ fetchImpl: async () => { throw new Error('down'); } });
  const res = await callHandler(provider, '/api/geomag');
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /geomag_upstream_unavailable/);
});

// — frontend data client -----------------------------------------------------

test('createGeomagSource refresh stores snapshot, fail-soft on error', async () => {
  const payload = { fetchedAt: 1, observatories: [] };
  const source = createGeomagSource({
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
