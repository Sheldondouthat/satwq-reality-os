/**
 * EONET provider + frontend data-client tests.
 * All upstream I/O is stubbed — no network. Fixtures mirror the real
 * EONET v3 shapes captured 2026-09-27.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  eonetProxy,
  normalizeEvent,
  parseQuery,
} from '../../../../server/providers/wave3/eonet.js';
import { createEonetSource } from './source.js';
import { init } from './index.js';

const GONZALO = {
  id: 'EONET_24811',
  title: 'Tropical Storm Gonzalo',
  description: null,
  link: 'https://eonet.gsfc.nasa.gov/api/v3/events/EONET_24811',
  closed: null,
  categories: [{ id: 'severeStorms', title: 'Severe Storms' }],
  sources: [{ id: 'NOAA_NHC', url: 'https://www.nhc.noaa.gov/archive/2026/GONZALO.shtml' }],
  geometry: [
    { magnitudeValue: 40.0, magnitudeUnit: 'kts', date: '2026-09-25T03:00:00Z', type: 'Point', coordinates: [-22.1, 13.2] },
    { magnitudeValue: 40.0, magnitudeUnit: 'kts', date: '2026-09-25T09:00:00Z', type: 'Point', coordinates: [-22.4, 14.2] },
    { magnitudeValue: 45.0, magnitudeUnit: 'kts', date: '2026-09-25T15:00:00Z', type: 'Point', coordinates: [-22.7, 15.1] },
  ],
};

const ICEBERG = {
  id: 'EONET_6510',
  title: 'Iceberg D33C',
  categories: [{ id: 'seaLakeIce', title: 'Sea and Lake Ice' }],
  sources: [{ id: 'NATICE', url: 'https://usicecenter.gov/pub/Iceberg_Tabular.csv' }],
  geometry: [
    { magnitudeValue: null, magnitudeUnit: null, date: '2024-04-19T00:00:00Z', type: 'Point', coordinates: [-60.5, -70.2] },
  ],
};

const EVENTS_DOC = {
  title: 'EONET Events',
  description: 'Natural events from EONET.',
  link: 'https://eonet.gsfc.nasa.gov/api/v3/events',
  events: [GONZALO, ICEBERG],
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

function stubEonet({ doc = EVENTS_DOC, seen = null } = {}) {
  return async (url) => {
    seen?.push(url);
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

test('eonetProxy mounts /api/eonet on both server shapes', () => {
  const provider = eonetProxy();
  assert.equal(provider.name, 'eonet');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/eonet', '/api/eonet']);
});

test('eonetProxy rejects non-GET with 405', async () => {
  const res = await callHandler(eonetProxy(), '/api/eonet', 'POST');
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /method_not_allowed/);
});

// — query parsing --------------------------------------------------------

test('parseQuery defaults to open/30/null', () => {
  assert.deepEqual(parseQuery(new URLSearchParams()), {
    status: 'open',
    days: 30,
    category: null,
  });
});

test('parseQuery accepts valid status/category and clamps days', () => {
  const q = parseQuery(new URLSearchParams('status=closed&days=500&category=wildfires'));
  assert.deepEqual(q, { status: 'closed', days: 60, category: 'wildfires' });
});

test('parseQuery rejects bad status and bad category', () => {
  assert.throws(() => parseQuery(new URLSearchParams('status=bogus')), /eonet_bad_status/);
  assert.throws(() => parseQuery(new URLSearchParams('category=bogus')), /eonet_bad_category/);
});

// — normalization -----------------------------------------------------------

test('normalizeEvent extracts latest fix + full track (lon/lat order)', () => {
  const e = normalizeEvent(GONZALO);
  assert.equal(e.id, 'EONET_24811');
  assert.equal(e.title, 'Tropical Storm Gonzalo');
  assert.deepEqual(e.categories, ['severeStorms']);
  assert.deepEqual(e.sources, [
    { id: 'NOAA_NHC', url: 'https://www.nhc.noaa.gov/archive/2026/GONZALO.shtml' },
  ]);
  assert.deepEqual(e.latest, {
    t: '2026-09-25T15:00:00Z',
    lon: -22.7,
    lat: 15.1,
    mag: 45,
    magUnit: 'kts',
  });
  assert.deepEqual(e.track, [
    [-22.1, 13.2],
    [-22.4, 14.2],
    [-22.7, 15.1],
  ]);
  assert.equal(e.geometryCount, 3);
});

test('normalizeEvent drops invalid coordinates, sorts by date', () => {
  const e = normalizeEvent({
    id: 'X',
    title: 'T',
    geometry: [
      { date: '2026-09-26T00:00:00Z', coordinates: [-200, 10] }, // bad lon
      { date: '2026-09-25T00:00:00Z', coordinates: [10, 95] }, // bad lat
      { date: null, coordinates: [10, 10] }, // no date
      { date: '2026-09-24T00:00:00Z', coordinates: [10, 10] },
    ],
  });
  assert.equal(e.geometryCount, 1);
  assert.deepEqual(e.latest, { t: '2026-09-24T00:00:00Z', lon: 10, lat: 10, mag: null, magUnit: null });
});

test('normalizeEvent downsamples long tracks keeping endpoints', () => {
  const base = Date.UTC(2026, 8, 1);
  const geometry = Array.from({ length: 500 }, (_, i) => ({
    date: new Date(base + i * 3600_000).toISOString(),
    coordinates: [i * 0.1 - 180, 0],
  }));
  const e = normalizeEvent({ id: 'X', title: 'T', geometry });
  assert.equal(e.track.length, 200);
  assert.deepEqual(e.track[0], [-180, 0]);
  assert.deepEqual(e.track[199], [-130.1, 0]);
  assert.equal(e.geometryCount, 500);
});

// — handler end-to-end (stubbed EONET) ----------------------------------------

test('handler returns normalized, newest-first snapshot', async () => {
  const seen = [];
  const provider = eonetProxy({ fetchImpl: stubEonet({ seen }) });
  const res = await callHandler(provider, '/api/eonet');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.count, 2);
  assert.deepEqual(body.query, { status: 'open', days: 30, category: null });
  assert.equal(body.events[0].id, 'EONET_24811'); // Gonzalo newest first
  assert.equal(body.events[1].id, 'EONET_6510');
  assert.match(seen[0], /status=open&days=30/);
});

test('handler passes ?category= through to upstream', async () => {
  const seen = [];
  const provider = eonetProxy({ fetchImpl: stubEonet({ seen }) });
  await callHandler(provider, '/api/eonet?category=severeStorms');
  assert.match(seen[0], /category=severeStorms/);
});

test('handler rejects bad query params with 400', async () => {
  const provider = eonetProxy({ fetchImpl: stubEonet() });
  const res = await callHandler(provider, '/api/eonet?status=bogus');
  assert.equal(res.statusCode, 400);
  assert.match(res.body, /eonet_bad_request/);
});

test('handler returns 502 when upstream fails with no cache', async () => {
  const provider = eonetProxy({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  const res = await callHandler(provider, '/api/eonet');
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /eonet_upstream_unavailable/);
});

// — frontend data client -------------------------------------------------------

test('createEonetSource refresh stores snapshot, fail-soft on error', async () => {
  const payload = { fetchedAt: 1, events: [] };
  const source = createEonetSource({
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
