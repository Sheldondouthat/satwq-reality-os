/**
 * NMDB provider + frontend data-client tests.
 * All upstream I/O is stubbed — no network. Fixtures mirror the real NEST
 * ASCII layout captured 2026-09-27 (header block + `YYYY-MM-DD HH:MM:SS; v`
 * data lines).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nmdbProxy,
  parseNestAscii,
  normalizeStationBlock,
} from '../../../../server/providers/wave3/nmdb.js';
import { createNmdbSource } from './source.js';
import { init } from './index.js';

const NEST_FIXTURE = `
<pre><code>#_____________ QUERY RESULTS SUMMARY ___________________________________
#        STATION: KERG
#     START TIME: 2026-09-26 05:55:00 UTC
#       END TIME: 2026-09-27 05:32:00 UTC
#     NMDB TABLE: revised original
#      DATA TYPE: corr_for_efficiency(RCORR_E)
#      AVERAGING: No
#   ORIGINAL RES: 1 min
#_______________________________________________________________________
#
# Timestamps always correspond to the beginning of the time interval
2026-09-26 05:55:00; -1.007
2026-09-26 05:56:00; 1.550
2026-09-26 05:57:00; 0.167
2026-09-26 05:58:00; -0.420
2026-09-26 05:59:00; not_a_number
2026-09-26 06:00:00; 0.300
#_____________ QUERY RESULTS SUMMARY ___________________________________
#        STATION: OULU
#     START TIME: 2026-09-26 05:55:00 UTC
#      DATA TYPE: corr_for_efficiency(RCORR_E)
2026-09-26 05:55:00; 2.100
2026-09-26 05:56:00; 2.300
</code></pre>
`;

function fakeReq(url, method = 'GET') {
  return {
    method,
    url,
    on() {},
    removeListener() {},
    headers: {},
  };
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

function stubFetchOk(text) {
  return async () => ({
    ok: true,
    headers: { get: () => null },
    text: async () => text,
  });
}

function stubFetchJson(payload) {
  return async () => ({
    ok: true,
    json: async () => payload,
  });
}

async function callHandler(provider, url, method = 'GET') {
  const calls = [];
  const middlewares = { use: (route, handler) => calls.push({ route, handler }) };
  provider.configureServer({ middlewares });
  const res = fakeRes();
  await calls[0].handler(fakeReq(url, method), res);
  return { res, calls };
}

// — provider shape -------------------------------------------------------

test('nmdbProxy mounts /api/nmdb on both server shapes', () => {
  const provider = nmdbProxy();
  assert.equal(provider.name, 'nmdb');
  const seen = [];
  const middlewares = { use: (route) => seen.push(route) };
  provider.configureServer({ middlewares });
  provider.configurePreviewServer({ middlewares });
  assert.deepEqual(seen, ['/api/nmdb', '/api/nmdb']);
});

test('nmdbProxy rejects non-GET with 405', async () => {
  const { res } = await callHandler(nmdbProxy(), '/api/nmdb', 'POST');
  assert.equal(res.statusCode, 405);
  assert.match(res.body, /method_not_allowed/);
});

// — parser ----------------------------------------------------------------

test('parseNestAscii splits station blocks and reads meta + rows', () => {
  const blocks = parseNestAscii(NEST_FIXTURE);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].code, 'KERG');
  assert.equal(blocks[0].meta['START TIME'], '2026-09-26 05:55:00 UTC');
  assert.equal(blocks[0].meta['DATA TYPE'], 'corr_for_efficiency(RCORR_E)');
  assert.equal(blocks[0].rows.length, 5); // malformed line skipped
  assert.deepEqual(blocks[0].rows[0], { t: '2026-09-26 05:55:00', value: -1.007 });
  assert.equal(blocks[1].code, 'OULU');
  assert.equal(blocks[1].rows.length, 2);
});

test('parseNestAscii returns [] for empty/garbage input', () => {
  assert.deepEqual(parseNestAscii(''), []);
  assert.deepEqual(parseNestAscii('<html>no data</html>'), []);
});

// — normalization ----------------------------------------------------------

test('normalizeStationBlock computes median, latest, deviation, deviationMAD', () => {
  const blocks = parseNestAscii(NEST_FIXTURE);
  const row = normalizeStationBlock(blocks[1]); // OULU: 2.100, 2.300
  assert.equal(row.code, 'OULU');
  assert.equal(row.name, 'Oulu');
  assert.equal(row.lat, 65.05);
  assert.equal(row.lon, 25.47);
  assert.equal(row.median, 2.2);
  assert.deepEqual(row.latest, { t: '2026-09-26 05:56:00Z', value: 2.3 });
  // deviation = 2.3 − 2.2 = 0.1 (native series units);
  // mad = median(|2.1−2.2|, |2.3−2.2|) = 0.1 → deviationMAD = 1.0
  assert.equal(row.deviation, 0.1);
  assert.equal(row.deviationMAD, 1);
  assert.equal(row.samples, 2);
  assert.equal(row.status, 'ok');
});

test('normalizeStationBlock stays stable when the window median is near zero', () => {
  // Regression: percent-of-median exploded to -2934% on live OULU data
  // (median -0.044). The MAD-based deviation must stay finite.
  const row = normalizeStationBlock({
    code: 'OULU',
    meta: {},
    rows: [
      { t: '2026-09-27 06:00:00', value: -1.335 },
      { t: '2026-09-27 06:01:00', value: -0.044 },
      { t: '2026-09-27 06:02:00', value: 0.956 },
    ],
  });
  assert.equal(row.median, -0.04);
  assert.ok(Number.isFinite(row.deviationMAD));
  assert.ok(Math.abs(row.deviationMAD) < 100);
});

test('normalizeStationBlock returns null deviationMAD for a constant series', () => {
  const row = normalizeStationBlock({
    code: 'OULU',
    meta: {},
    rows: [
      { t: '2026-09-27 06:00:00', value: 1.5 },
      { t: '2026-09-27 06:01:00', value: 1.5 },
    ],
  });
  assert.equal(row.deviation, 0);
  assert.equal(row.deviationMAD, null); // mad = 0 → undefined, not Infinity
});

test('normalizeStationBlock marks empty blocks nodata', () => {
  const row = normalizeStationBlock({ code: 'KERG', meta: {}, rows: [] });
  assert.equal(row.status, 'nodata');
  assert.equal(row.latest, null);
});

// — handler end-to-end (stubbed upstream) ------------------------------------

test('handler returns normalized snapshot from stubbed NEST', async () => {
  const provider = nmdbProxy({ fetchImpl: stubFetchOk(NEST_FIXTURE) });
  const { res } = await callHandler(provider, '/api/nmdb');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.unavailable, false);
  assert.equal(body.period.days, 1);
  assert.equal(body.stations.length, 12); // default curated set
  const kerg = body.stations.find((s) => s.code === 'KERG');
  assert.equal(kerg.status, 'ok');
  assert.equal(kerg.samples, 5);
  assert.equal(kerg.lat, -49.35);
  const missing = body.stations.find((s) => s.code === 'JUNG');
  assert.equal(missing.status, 'nodata');
});

test('handler drops non-allowlisted blocks from a mangled upstream page', async () => {
  // Regression: a truncated NEST page yielded "# STATION: KERG," which the
  // defensive extra-block merge passed through as a phantom station.
  const mangled = `${NEST_FIXTURE}\n# STATION: KERG,\n2026-09-26 05:56:00; 1.0\n`;
  const provider = nmdbProxy({ fetchImpl: stubFetchOk(mangled) });
  const { res } = await callHandler(provider, '/api/nmdb');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  const codes = body.stations.map((s) => s.code);
  assert.ok(!codes.includes('KERG,'));
  assert.ok(codes.every((c) => /^[A-Z0-9]{2,6}$/.test(c)));
});

test('handler honors ?stations= allowlist and drops unknown codes', async () => {
  let seenUrl = '';
  const provider = nmdbProxy({
    fetchImpl: async (url) => {
      seenUrl = url;
      return { ok: true, headers: { get: () => null }, text: async () => NEST_FIXTURE };
    },
  });
  const { res } = await callHandler(provider, '/api/nmdb?stations=OULU,NOPE,KERG');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.deepEqual(
    body.stations.map((s) => s.code),
    ['OULU', 'KERG'],
  );
  assert.match(seenUrl, /stations%5B%5D=OULU/);
  assert.doesNotMatch(seenUrl, /NOPE/);
});

test('handler returns 502 when upstream fails with no cache', async () => {
  const provider = nmdbProxy({ fetchImpl: async () => ({ ok: false, status: 503 }) });
  const { res } = await callHandler(provider, '/api/nmdb');
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /nmdb_upstream_unavailable/);
});

test('handler serves stale cache when refresh fails after TTL', async () => {
  let fail = false;
  const provider = nmdbProxy({
    fetchImpl: async () => {
      if (fail) return { ok: false, status: 500 };
      return { ok: true, headers: { get: () => null }, text: async () => NEST_FIXTURE };
    },
  });
  const first = await callHandler(provider, '/api/nmdb');
  assert.equal(first.res.statusCode, 200);
  assert.equal(JSON.parse(first.res.body).stale, false);
  // Expire the 10-min cache, then break the upstream.
  const realNow = Date.now;
  fail = true;
  Date.now = () => realNow() + 11 * 60 * 1000;
  try {
    const second = await callHandler(provider, '/api/nmdb');
    assert.equal(second.res.statusCode, 200);
    const body = JSON.parse(second.res.body);
    assert.equal(body.stale, true);
    assert.equal(body.stations.find((s) => s.code === 'KERG').status, 'ok');
  } finally {
    Date.now = realNow;
  }
});

// — frontend data client -----------------------------------------------------

test('createNmdbSource refresh stores snapshot and notifies', async () => {
  const payload = { fetchedAt: 1, stations: [{ code: 'OULU' }] };
  const source = createNmdbSource({ fetchImpl: stubFetchJson(payload), refreshMs: 50 });
  const seen = [];
  const stop = source.start((snap) => seen.push(snap));
  const result = await source.refresh();
  assert.equal(result.ok, true);
  assert.deepEqual(source.getSnapshot(), payload);
  assert.equal(seen.length >= 1, true);
  stop();
  assert.equal(source.getSnapshot(), payload);
});

test('createNmdbSource refresh is fail-soft and keeps last good', async () => {
  let fail = false;
  const source = createNmdbSource({
    fetchImpl: async () => {
      if (fail) throw new Error('boom');
      return { ok: true, json: async () => ({ ok: 1 }) };
    },
  });
  const good = await source.refresh();
  assert.equal(good.ok, true);
  fail = true;
  const bad = await source.refresh();
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /boom/);
  assert.deepEqual(source.getSnapshot(), { ok: 1 });
  assert.equal(source.getLastError(), 'boom');
});

test('init never throws and returns a working handle', async () => {
  const handle = init({
    fetchImpl: stubFetchJson({ fetchedAt: 1, stations: [] }),
    refreshMs: 30,
  });
  assert.ok(handle && typeof handle.stop === 'function');
  assert.equal(typeof handle.getSnapshot, 'function');
  handle.stop();
  const broken = init({ fetchImpl: null, proxyBase: 42 });
  assert.equal(broken.getSnapshot(), null);
  broken.stop();
});
