/**
 * Wave 9 — surf provider tests.
 *
 * Fixtures are REAL 2026-10-02 api.weather.gov gridpoints bytes
 * (Pipeline HFO/146,161, fields sliced to the 5 wave fields + updateTime).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  surfProxy,
  parseValidTime,
  parseSpot,
  buildPayload,
  M_TO_FT,
  _surfInternals,
} from './surf.js';
const { numOrNull } = _surfInternals;

const ROOT = dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  readFileSync(join(ROOT, 'fixtures', 'surf-pipeline-2026-10-02.json'), 'utf8'),
);
const PROPS = FIXTURE.properties;
const PIPELINE = _surfInternals.SPOTS.find((s) => s.id === 'pipeline');
const NOW_MS = Date.parse('2026-10-02T15:45:00Z');

test('parseValidTime parses PT4H', () => {
  const r = parseValidTime('2026-10-02T08:00:00+00:00/PT4H');
  assert.equal(r.startMs, Date.parse('2026-10-02T08:00:00Z'));
  assert.equal(r.durMs, 4 * 3600 * 1000);
});

test('parseValidTime parses P1DT12H', () => {
  const r = parseValidTime('2026-10-03T00:00:00+00:00/P1DT12H');
  assert.equal(r.durMs, 36 * 3600 * 1000);
});

test('parseValidTime returns null on malformed input', () => {
  assert.equal(parseValidTime(null), null);
  assert.equal(parseValidTime('not-a-time'), null);
  assert.equal(parseValidTime('2026-10-02T08:00:00Z'), null);
  assert.equal(parseValidTime('2026-10-02T08:00:00Z/banana'), null);
});

test('parseSpot extracts latest waveHeight from real fixture bytes', () => {
  const spot = parseSpot(PIPELINE, PROPS, NOW_MS);
  assert.equal(spot.ok, true);
  assert.equal(spot.latest.waveHeightM, 0.3048);
  assert.equal(spot.latest.wavePeriodS, 11);
  assert.equal(spot.latest.wavePeriod2S, 9);
  assert.equal(spot.updateTime, '2026-10-02T14:02:45+00:00');
});

test('parseSpot: waveDirection missing (0 rows) reads null, not 0', () => {
  const spot = parseSpot(PIPELINE, PROPS, NOW_MS);
  assert.equal(PROPS.waveDirection.values.length, 0); // fixture really has none
  assert.equal(spot.latest.waveDirectionDeg, null);
  assert.equal(spot.fieldRows.waveDirection, 0);
});

test('parseSpot: real model 0.0 is preserved, never nulled', () => {
  // windWaveHeight[0] is a real 0.0 in the fixture bytes.
  assert.equal(PROPS.windWaveHeight.values[0].value, 0);
  const spot = parseSpot(PIPELINE, PROPS, NOW_MS);
  assert.equal(spot.latest.windWaveHeightM, 0);
});

test('numOrNull guards the Number(\'\')===0 trap', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull('0'), 0);
  assert.equal(numOrNull(0), 0);
  assert.equal(numOrNull('0.3048'), 0.3048);
});

test('parseSpot computes next-24h max from rows inside the horizon', () => {
  const spot = parseSpot(PIPELINE, PROPS, NOW_MS);
  // Rows starting <= 2026-10-03T15:45Z: 10-02T08 (0.3048), 10-02T12 (0.6096), 10-03T00 (0.3048).
  assert.equal(spot.next24hRows, 3);
  assert.equal(spot.next24hMaxWaveHeightM, 0.6096);
});

test('parseSpot skips malformed validTime rows without crashing', () => {
  const props = {
    updateTime: '2026-10-02T14:02:45+00:00',
    waveHeight: { uom: 'wmoUnit:m', values: [
      { validTime: 'garbage', value: 9.99 },
      { validTime: '2026-10-02T08:00:00+00:00/PT4H', value: 1.2 },
    ] },
  };
  const spot = parseSpot(PIPELINE, props, NOW_MS);
  assert.equal(spot.fieldRows.waveHeight, 1);
  assert.equal(spot.latest.waveHeightM, 1.2);
});

test('SPOTS: 8 pinned, ids wellformed, grids wellformed', () => {
  assert.equal(_surfInternals.SPOTS.length, 8);
  const seen = new Set();
  for (const s of _surfInternals.SPOTS) {
    assert.ok(/^[a-z0-9-]{1,32}$/.test(s.id), `bad id ${s.id}`);
    assert.ok(!seen.has(s.id), `dup id ${s.id}`);
    seen.add(s.id);
    assert.ok(/^[A-Z]{3}$/.test(s.wfo), `bad wfo ${s.wfo}`);
    assert.ok(Number.isInteger(s.x) && Number.isInteger(s.y), `bad grid ${s.id}`);
  }
});

test('buildPayload summary picks the max next-24h wave spot', () => {
  const a = { ok: true, id: 'a', next24hMaxWaveHeightM: 0.5 };
  const b = { ok: true, id: 'b', next24hMaxWaveHeightM: 1.524 };
  const c = { ok: false, id: 'c' };
  const p = buildPayload([a, b, c], false);
  assert.equal(p.summary.total, 3);
  assert.equal(p.summary.ok, 2);
  assert.equal(p.summary.dark, 1);
  assert.equal(p.summary.maxWaveHeightM, 1.524);
  assert.equal(p.summary.maxWaveSpotId, 'b');
  assert.ok(p.honesty.forecastNotObserved.length > 20);
});

test('M_TO_FT converts meters to feet (ticker unit)', () => {
  assert.ok(Math.abs(0.3048 * M_TO_FT - 1.0) < 0.001);
});

// --- handler tests with a mocked global fetch ---

function mockRes() {
  const chunks = [];
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(chunk) { this.body = chunk; },
    get json() { return JSON.parse(this.body); },
    chunks,
  };
}

function fakeGridDoc(overrides = {}) {
  return {
    properties: {
      updateTime: '2026-10-02T14:02:45+00:00',
      waveHeight: { uom: 'wmoUnit:m', values: [{ validTime: '2026-10-02T08:00:00+00:00/PT4H', value: 0.6096 }] },
      wavePeriod: { uom: 'nwsUnit:s', values: [{ validTime: '2026-10-02T08:00:00+00:00/PT4H', value: 12 }] },
      waveDirection: { uom: 'wmoUnit:degree', values: [] },
      wavePeriod2: { uom: 'nwsUnit:s', values: [] },
      windWaveHeight: { uom: 'wmoUnit:m', values: [] },
      ...overrides,
    },
  };
}

function installFetch(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = orig; };
}

function jsonResponse(doc, ok = true, status = 200) {
  const text = JSON.stringify(doc);
  const bytes = new TextEncoder().encode(text);
  return {
    ok,
    status,
    headers: { get: () => null },
    arrayBuffer: async () => bytes.buffer.slice(0),
  };
}

test('handler: ?spot=atlantis -> 200 requestedNotFound', async () => {
  _surfInternals.resetCache();
  const proxy = surfProxy();
  const seen = {};
  await new Promise((resolve) => {
    proxy.configureServer({ middlewares: { use: (route, handler) => {
      handler({ method: 'GET', url: '/api/surf?spot=atlantis' }, {
        writeHead(s) { seen.status = s; },
        end(c) { seen.body = c; resolve(); },
      });
    } } });
  });
  assert.equal(seen.status, 200);
  assert.equal(JSON.parse(seen.body).requestedNotFound, true);
});

test('handler: ?spot=BAD! -> 400', async () => {
  _surfInternals.resetCache();
  const proxy = surfProxy();
  let status = null;
  let body = null;
  await new Promise((resolve) => {
    proxy.configureServer({ middlewares: { use: (route, handler) => {
      handler({ method: 'GET', url: '/api/surf?spot=BAD!' }, {
        writeHead(s) { status = s; },
        end(c) { body = c; resolve(); },
      });
    } } });
  });
  assert.equal(status, 400);
  assert.equal(JSON.parse(body).error, 'surf_bad_spot');
});

test('handler: single spot fetch works end-to-end with fake bytes', async () => {
  _surfInternals.resetCache();
  const restore = installFetch(async (url) => {
    assert.ok(String(url).includes('/gridpoints/'), `unexpected url ${url}`);
    return jsonResponse(fakeGridDoc());
  });
  try {
    const proxy = surfProxy();
    let status = null;
    let body = null;
    await new Promise((resolve) => {
      proxy.configureServer({ middlewares: { use: (route, handler) => {
        handler({ method: 'GET', url: '/api/surf?spot=pipeline' }, {
          writeHead(s) { status = s; },
          end(c) { body = c; resolve(); },
        });
      } } });
    });
    assert.equal(status, 200);
    const doc = JSON.parse(body);
    assert.equal(doc.spots.length, 1);
    assert.equal(doc.spots[0].id, 'pipeline');
    assert.equal(doc.spots[0].latest.waveHeightM, 0.6096);
    assert.equal(doc.summary.ok, 1);
  } finally {
    restore();
  }
});

test('handler: one dark spot is fail-soft; all dark is an honest 502', async () => {
  _surfInternals.resetCache();
  // One spot throws, rest succeed.
  const restore = installFetch(async (url) => {
    if (String(url).includes('/HFO/146,161')) throw new Error('fetch failed');
    return jsonResponse(fakeGridDoc());
  });
  try {
    const proxy = surfProxy();
    let status = null;
    let body = null;
    await new Promise((resolve) => {
      proxy.configureServer({ middlewares: { use: (route, handler) => {
        handler({ method: 'GET', url: '/api/surf' }, {
          writeHead(s) { status = s; },
          end(c) { body = c; resolve(); },
        });
      } } });
    });
    assert.equal(status, 200);
    const doc = JSON.parse(body);
    assert.equal(doc.summary.ok, 7);
    assert.equal(doc.summary.dark, 1);
    assert.equal(doc.spots.find((s) => s.id === 'pipeline').ok, false);
  } finally {
    restore();
  }

  // All spots throw -> 502.
  _surfInternals.resetCache();
  const restore2 = installFetch(async () => { throw new Error('fetch failed'); });
  try {
    const proxy = surfProxy();
    let status = null;
    let body = null;
    await new Promise((resolve) => {
      proxy.configureServer({ middlewares: { use: (route, handler) => {
        handler({ method: 'GET', url: '/api/surf' }, {
          writeHead(s) { status = s; },
          end(c) { body = c; resolve(); },
        });
      } } });
    });
    assert.equal(status, 502);
    assert.equal(JSON.parse(body).error, 'surf_unavailable');
  } finally {
    restore2();
  }
});
