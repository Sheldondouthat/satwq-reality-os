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
  isFillerF,
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

// — no-data filler (catalog fill = 99999.0; live HON/MBO captures
//   2026-11-15: filler appears as the newest sample's F, and as the
//   whole dead tail of MBO's final window) ----------------------------

test('isFillerF matches only the catalog-declared 99999 fill', () => {
  assert.equal(isFillerF(99999), true);
  assert.equal(isFillerF(99999.0), true);
  assert.equal(isFillerF(99998.99), false);
  assert.equal(isFillerF(-99999), false);
  assert.equal(isFillerF(88888), false);
  assert.equal(isFillerF(null), false);
});

test('normalizeObservatory flags a filler latest as no-data, stats untouched', () => {
  // HON-shaped: real samples, newest sample is the filler.
  const rows = [
    ['2026-11-15T10:14Z', 100],
    ['2026-11-15T10:15Z', 102],
    ['2026-11-15T10:16Z', 104],
    ['2026-11-15T10:17Z', 106],
    ['2026-11-15T10:18Z', 99999],
  ];
  const row = normalizeObservatory(OTT, rows);
  assert.equal(row.status, 'ok'); // the station's window is real
  assert.deepEqual(row.latest, { t: '2026-11-15T10:18Z', f: null });
  assert.equal(row.anomalyNT, null); // derived from latest — cannot stand
  // Regression pin: window stats are computed over ALL finite rows,
  // filler included, exactly as before the flag existed. Sorted
  // [100,102,104,106,99999] → median 104 (excluding the filler would
  // give (102+104)/2 = 103).
  assert.equal(row.medianF, 104);
  assert.equal(row.samples, 5);
});

test('normalizeObservatory leaves a real latest untouched despite filler mid-window', () => {
  const rows = [
    ['2026-11-15T10:14Z', 100],
    ['2026-11-15T10:15Z', 99999],
    ['2026-11-15T10:16Z', 104],
    ['2026-11-15T10:17Z', 106],
    ['2026-11-15T10:18Z', 108],
  ];
  const row = normalizeObservatory(OTT, rows);
  assert.equal(row.status, 'ok');
  assert.deepEqual(row.latest, { t: '2026-11-15T10:18Z', f: 108 });
  // sorted [100,104,106,108,99999] → median 106; anomaly = 108 − 106
  assert.equal(row.medianF, 106);
  assert.equal(row.anomalyNT, 2);
  assert.equal(row.samples, 5);
});

test('normalizeObservatory degrades an all-filler window to the nodata shape', () => {
  const rows = [
    ['2020-03-05T10:27Z', 99999],
    ['2020-03-05T10:28Z', 99999],
    ['2020-03-05T10:29Z', 99999],
  ];
  const row = normalizeObservatory(OTT, rows);
  assert.deepEqual(row, {
    code: 'OTT',
    name: 'Ottawa',
    lat: 45.403,
    lon: -75.552,
    dataset: 'ott/best-avail/PT1M/xyzf',
    latest: null,
    medianF: null,
    anomalyNT: null,
    samples: 0,
    status: 'nodata',
  });
});

test('handler serves filler latest flagged, not as a 99999 reading', async () => {
  const data = {
    ...DATA_OK,
    data: [...DATA_OK.data.slice(0, -1), ['2026-09-26T05:55Z', 99999]],
  };
  const provider = intermagnetProxy({ fetchImpl: stubHapi({ data }) });
  const res = await callHandler(provider, '/api/geomag');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const ott = body.observatories.find((o) => o.code === 'OTT');
  assert.equal(ott.status, 'ok');
  assert.deepEqual(ott.latest, { t: '2026-09-26T05:55Z', f: null });
  assert.equal(ott.anomalyNT, null);
  assert.ok(ott.medianF !== null && ott.medianF < 99999);
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
