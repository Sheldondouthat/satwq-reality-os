import assert from 'node:assert/strict';
import test from 'node:test';
import { currentsProxy, _currentsInternals } from './currents.js';

const {
  SNAPSHOT_URL,
  parseHfradarAscii,
  buildCurrentsSnapshot,
  validateCurrentsSnapshot,
  clearCaches,
} = _currentsInternals;

// ——— fixtures ———

const EPOCH = Date.parse('2026-09-27T20:00:00Z') / 1000;

// Mimics a THREDDS OPeNDAP .ascii response: section headers, one wrapped
// data line (v row 0 spans two lines), a fill value in u row 1.
const ASCII_FIXTURE = `time[1]
${EPOCH}

lat[3]
25.0, 25.1, 25.2

lon[4]
-80.0, -79.9, -79.8, -79.7

u.u[1][3][4]
[0][0], 10, 20, 30, 40
[0][1], -32767, 60, 70, 80
[0][2], 90, 100, 110, 120

v.v[1][3][4]
[0][0], 5, 15
25, 35
[0][1], 45, 55, 65, 75
[0][2], 85, 95, 105, 115
`;

function fixtureRegion(overrides = {}) {
  const n = 12;
  return {
    region: 'rtv-test',
    upstreamFile:
      'rtv-test_v1r0_hfr_s202609272000000_e202609272000000_c202609272101328.nc',
    upstreamUrl: 'https://dods.ndbc.noaa.gov/thredds/dodsC/hfradar/rtv-test.nc',
    time: '2026-09-27T20:00:00.000Z',
    lon: Array.from({ length: n }, (_, i) => -80 + i * 0.01),
    lat: Array.from({ length: n }, () => 25.0),
    u: Array.from({ length: n }, (_, i) => 0.1 + i * 0.01),
    v: Array.from({ length: n }, () => 0.05),
    ...overrides,
  };
}

function fixtureSnapshot() {
  return buildCurrentsSnapshot({
    fetchedAt: '2026-09-27T21:05:00.000Z',
    regions: [fixtureRegion()],
  });
}

function snapshotResponse(snap) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify(snap),
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
    once() {},
    removeListener() {},
  };
  return res;
}

function mount(provider) {
  const calls = [];
  provider.configureServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  provider.configurePreviewServer({
    middlewares: { use: (route, handler) => calls.push({ route, handler }) },
  });
  return calls;
}

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

// ——— parser unit tests ———

test('parseHfradarAscii parses axes, time, and grids (incl. wrapped lines)', () => {
  const p = parseHfradarAscii(ASCII_FIXTURE);
  assert.equal(p.time, '2026-09-27T20:00:00.000Z');
  assert.deepEqual(p.lat, [25.0, 25.1, 25.2]);
  assert.deepEqual(p.lon, [-80.0, -79.9, -79.8, -79.7]);
  assert.deepEqual(p.u, [
    [10, 20, 30, 40],
    [-32767, 60, 70, 80],
    [90, 100, 110, 120],
  ]);
  // v row 0 was split across two lines and must reassemble.
  assert.deepEqual(p.v[0], [5, 15, 25, 35]);
  assert.deepEqual(p.v[2], [85, 95, 105, 115]);
});

test('parseHfradarAscii rejects empty and malformed input', () => {
  assert.throws(() => parseHfradarAscii(''), /empty response/);
  assert.throws(
    () => parseHfradarAscii('time[1]\nnot-a-number\n'),
    /bad time values/,
  );
  assert.throws(
    () => parseHfradarAscii('time[1]\n1\n\nlat[2]\n25.0\n'),
    /lat has 1 values, expected 2/,
  );
  assert.throws(
    () => parseHfradarAscii('definitely not opendap\n'),
    /missing time/,
  );
});

// ——— build/validate unit tests ———

test('buildCurrentsSnapshot assembles a valid snapshot document', () => {
  const snap = fixtureSnapshot();
  assert.equal(snap.format, 'hfradar-snapshot');
  assert.equal(snap.formatVersion, 1);
  const region = snap.regions[0];
  assert.equal(region.region, 'rtv-test');
  assert.equal(region.pointCount, 12);
  assert.equal(region.lon.length, 12);
  const expectedMax = Math.round(Math.hypot(0.21, 0.05) * 1000) / 1000;
  assert.equal(region.stats.speedMax, expectedMax);
  assert.ok(
    region.stats.speedMean > 0 && region.stats.speedMean <= expectedMax,
  );
  assert.ok(validateCurrentsSnapshot(snap));
});

test('buildCurrentsSnapshot rejects implausible speeds and short regions', () => {
  assert.throws(
    () =>
      buildCurrentsSnapshot({
        fetchedAt: new Date().toISOString(),
        regions: [fixtureRegion({ u: fixtureRegion().u.map(() => 20) })],
      }),
    /implausible speed/,
  );
  assert.throws(
    () =>
      buildCurrentsSnapshot({
        fetchedAt: new Date().toISOString(),
        regions: [fixtureRegion({ lon: [1], lat: [1], u: [0], v: [0] })],
      }),
    /only 1 points \(min 10\)/,
  );
  assert.throws(
    () =>
      buildCurrentsSnapshot({
        fetchedAt: new Date().toISOString(),
        regions: [],
      }),
    /no regions/,
  );
});

test('validateCurrentsSnapshot rejects malformed snapshots', () => {
  assert.throws(() => validateCurrentsSnapshot({}), /bad format marker/);
  const snap = fixtureSnapshot();
  const badCount = JSON.parse(JSON.stringify(snap));
  badCount.regions[0].pointCount = 11;
  assert.throws(
    () => validateCurrentsSnapshot(badCount),
    /pointCount 11 != array length 12/,
  );
  const badStats = JSON.parse(JSON.stringify(snap));
  badStats.regions[0].stats.speedMax = 99;
  assert.throws(
    () => validateCurrentsSnapshot(badStats),
    /stats do not match arrays/,
  );
  const badCoord = JSON.parse(JSON.stringify(snap));
  badCoord.regions[0].lon[0] = 999;
  assert.throws(
    () => validateCurrentsSnapshot(badCoord),
    /coordinate out of range/,
  );
  const badLen = JSON.parse(JSON.stringify(snap));
  badLen.regions[0].v.pop();
  assert.throws(() => validateCurrentsSnapshot(badLen), /arrays differ/);
});

// ——— handler tests ———

test('handler mounts /api/currents and serves the snapshot (redirect:follow)', async () => {
  clearCaches();
  const snap = fixtureSnapshot();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return snapshotResponse(snap);
  };
  const provider = currentsProxy({
    fetchImpl,
    now: () => Date.parse('2026-09-27T21:10:00Z'),
  });
  const calls = mount(provider);
  assert.deepEqual(
    calls.map((c) => c.route),
    ['/api/currents', '/api/currents'],
  );
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/currents' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.stale, false);
  assert.equal(body.regions.length, 1);
  assert.equal(body.regions[0].region, 'rtv-test');
  assert.equal(body.regions[0].lon.length, 12);
  assert.ok(body.attribution.includes('NDBC'));
  assert.equal(seen[0].url, SNAPSHOT_URL);
  assert.ok(seen.every((x) => x.options.redirect === 'follow'));
});

test('handler 405s on non-GET', async () => {
  clearCaches();
  const provider = currentsProxy({
    fetchImpl: async () => snapshotResponse(fixtureSnapshot()),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/currents' }, res);
  assert.equal(res.statusCode, 405);
});

test('handler 502s honestly when the snapshot is unreachable (no cache)', async () => {
  clearCaches();
  const provider = currentsProxy({
    fetchImpl: async () => {
      throw abortError();
    },
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/currents' }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'currents_unavailable');
});

test('handler 502s on a corrupt snapshot asset', async () => {
  clearCaches();
  const provider = currentsProxy({
    fetchImpl: async () => snapshotResponse({ format: 'nope' }),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/currents' }, res);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).detail, /bad format marker/);
});

test('handler serves stale cache when the refresh fails', async () => {
  clearCaches();
  const snap = fixtureSnapshot();
  const t0 = Date.parse('2026-09-27T21:10:00Z');
  const good = currentsProxy({
    fetchImpl: async () => snapshotResponse(snap),
    now: () => t0,
  });
  const callsGood = mount(good);
  const res1 = fakeRes();
  await callsGood[0].handler({ method: 'GET', url: '/api/currents' }, res1);
  assert.equal(res1.statusCode, 200);

  const bad = currentsProxy({
    fetchImpl: async () => {
      throw abortError();
    },
    now: () => t0 + 3600_000, // past the TTL, inside the stale window
  });
  const callsBad = mount(bad);
  const res2 = fakeRes();
  await callsBad[0].handler({ method: 'GET', url: '/api/currents' }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(JSON.parse(res2.body).stale, true);
});
