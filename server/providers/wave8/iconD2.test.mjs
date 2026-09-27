import assert from 'node:assert/strict';
import test from 'node:test';
import { iconD2Proxy, _iconD2Internals } from './iconD2.js';

const {
  SNAPSHOT_URL,
  binTemperatureGrid,
  buildIconD2Snapshot,
  validateIconD2Snapshot,
  clearCaches,
} = _iconD2Internals;

// ——— fixtures ———

// 8 cols x 6 rows, lon 10..17, lat 50..55 south→north, deterministic Kelvin.
// At binDeg=2 this bins to 4x3 = 12 cells (≥ the 10-cell floor).
function fixtureGrid() {
  const ni = 8;
  const nj = 6;
  const values = new Float64Array(ni * nj);
  for (let j = 0; j < nj; j++) {
    for (let i = 0; i < ni; i++) {
      values[j * ni + i] = 280 + i + 10 * j;
    }
  }
  // One DWD missing marker.
  values[1 * ni + 2] = 9999;
  return { ni, nj, lo1: 10, la1: 50, di: 1, dj: 1, values };
}

function fixtureSnapshot() {
  const binned = binTemperatureGrid(fixtureGrid(), 2); // 4x3 = 12 cells, one null
  return buildIconD2Snapshot({
    run: '2026-09-26T21:00:00.000Z',
    fetchedAt: '2026-09-27T00:05:00.000Z',
    param: 't_2m',
    units: 'K',
    horizons: [
      { forecastHour: 0, validTime: '2026-09-26T21:00:00.000Z', grid: binned },
      { forecastHour: 6, validTime: '2026-09-27T03:00:00.000Z', grid: binned },
    ],
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

// ——— binning unit tests ———

test('binTemperatureGrid bins 8x6 at 2deg → 4x3 cells with means', () => {
  const b = binTemperatureGrid(fixtureGrid(), 2);
  assert.equal(b.nx, 4);
  assert.equal(b.ny, 3);
  assert.equal(b.lon0, 10);
  assert.equal(b.lat0, 50);
  // Each 2x2 source block averages; the (bi=1,bj=0) block loses one point to
  // the 9999 marker: (282+283+293)/3 = 286.0.
  assert.deepEqual(
    b.values,
    [
      285.5, 286.0, 289.5, 291.5, 305.5, 307.5, 309.5, 311.5, 325.5, 327.5,
      329.5, 331.5,
    ],
  );
  assert.equal(b.pointCount, 12);
  assert.equal(b.missingCount, 0);
  assert.deepEqual(b.stats, { min: 285.5, max: 331.5, mean: 308.38 });
});

test('binTemperatureGrid emits null for all-missing cells', () => {
  const g = fixtureGrid();
  // Blank the whole (bi=1,bj=0) block (i=2..3, j=0..1) → that cell → null.
  for (const idx of [2, 3, 10, 11]) g.values[idx] = 9999;
  const b = binTemperatureGrid(g, 2);
  assert.equal(b.values[0], 285.5);
  assert.equal(b.values[1], null);
  assert.equal(b.values[2], 289.5);
  assert.equal(b.pointCount, 11);
  assert.equal(b.missingCount, 1);
});

test('binTemperatureGrid handles north→south scan (negative dj)', () => {
  // Same geographic field as fixtureGrid but stored north-first: flip the
  // values in j so each value keeps its true latitude.
  const g = fixtureGrid();
  const flipped = new Float64Array(g.values.length);
  for (let j = 0; j < g.nj; j++) {
    for (let i = 0; i < g.ni; i++) {
      flipped[j * g.ni + i] = g.values[(g.nj - 1 - j) * g.ni + i];
    }
  }
  g.values = flipped;
  g.la1 = 55;
  g.dj = -1;
  const b = binTemperatureGrid(g, 2);
  assert.equal(b.lat0, 50); // origin is always the southwest corner
  assert.equal(b.ny, 3);
  assert.deepEqual(
    b.values,
    [
      285.5, 286.0, 289.5, 291.5, 305.5, 307.5, 309.5, 311.5, 325.5, 327.5,
      329.5, 331.5,
    ],
  );
});

test('binTemperatureGrid normalizes 0..360 longitudes', () => {
  const g = fixtureGrid();
  g.lo1 = 358; // = -2
  const b = binTemperatureGrid(g, 2);
  assert.equal(b.lon0, -2);
});

test('binTemperatureGrid rejects bad geometry', () => {
  assert.throws(
    () =>
      binTemperatureGrid(
        { ni: 0, nj: 3, lo1: 0, la1: 0, di: 1, dj: 1, values: [] },
        2,
      ),
    /bad grid geometry/,
  );
  assert.throws(
    () =>
      binTemperatureGrid(
        { ni: 8, nj: 6, lo1: 0, la1: 0, di: 1, dj: 1, values: [1, 2] },
        2,
      ),
    /values shorter/,
  );
  const g = fixtureGrid();
  g.values.fill(9999);
  assert.throws(() => binTemperatureGrid(g, 2), /only 0 valid cells/);
});

// ——— build/validate unit tests ———

test('buildIconD2Snapshot produces a valid snapshot document', () => {
  const snap = fixtureSnapshot();
  assert.equal(snap.format, 'icon-d2-snapshot');
  assert.equal(snap.formatVersion, 1);
  assert.equal(snap.run, '2026-09-26T21:00:00.000Z');
  assert.equal(snap.horizons.length, 2);
  assert.equal(snap.horizons[0].forecastHour, 0);
  assert.equal(snap.horizons[1].forecastHour, 6);
  assert.equal(snap.grid.nx, 4);
  assert.equal(snap.grid.ny, 3);
  assert.ok(validateIconD2Snapshot(snap));
});

test('buildIconD2Snapshot rejects empty horizons', () => {
  assert.throws(
    () =>
      buildIconD2Snapshot({
        run: '2026-09-26T21:00:00.000Z',
        fetchedAt: new Date().toISOString(),
        horizons: [],
      }),
    /no horizons/,
  );
});

test('validateIconD2Snapshot rejects malformed snapshots', () => {
  assert.throws(() => validateIconD2Snapshot({}), /icon_d2_snapshot_invalid/);
  const snap = fixtureSnapshot();
  const badLen = {
    ...snap,
    horizons: [{ ...snap.horizons[0], values: [1, 2] }],
  };
  assert.throws(() => validateIconD2Snapshot(badLen), /values length/);
  const badPhys = JSON.parse(JSON.stringify(snap));
  badPhys.horizons[0].stats.max = 500;
  assert.throws(() => validateIconD2Snapshot(badPhys), /physical bounds/);
  const unsorted = JSON.parse(JSON.stringify(snap));
  unsorted.horizons[0].values[0] = Number.NaN;
  assert.throws(() => validateIconD2Snapshot(unsorted), /non-finite/);
});

// ——— handler tests ———

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

test('handler mounts /api/icon-d2 and serves the snapshot (redirect:follow)', async () => {
  clearCaches();
  const snap = fixtureSnapshot();
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return snapshotResponse(snap);
  };
  const provider = iconD2Proxy({
    fetchImpl,
    now: () => Date.parse('2026-09-27T00:10:00Z'),
  });
  const calls = mount(provider);
  assert.deepEqual(
    calls.map((c) => c.route),
    ['/api/icon-d2', '/api/icon-d2'],
  );
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/icon-d2' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.stale, false);
  assert.equal(body.snapshot.run, '2026-09-26T21:00:00.000Z');
  assert.equal(body.horizons.length, 2);
  assert.equal(body.horizons[0].values.length, 12);
  assert.equal(body.horizons[0].values[1], 286.0); // 9999 marker cell loses one point
  assert.ok(body.attribution.includes('DWD'));
  assert.equal(seen[0].url, SNAPSHOT_URL);
  assert.ok(seen.every((x) => x.options.redirect === 'follow'));
});

test('handler 405s on non-GET', async () => {
  clearCaches();
  const provider = iconD2Proxy({
    fetchImpl: async () => snapshotResponse(fixtureSnapshot()),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/icon-d2' }, res);
  assert.equal(res.statusCode, 405);
});

test('handler 502s honestly when the snapshot is unreachable (no cache)', async () => {
  clearCaches();
  const provider = iconD2Proxy({
    fetchImpl: async () => {
      throw abortError();
    },
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/icon-d2' }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'icon_d2_unavailable');
});

test('handler 502s on a corrupt snapshot asset', async () => {
  clearCaches();
  const provider = iconD2Proxy({
    fetchImpl: async () => snapshotResponse({ format: 'nope' }),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/icon-d2' }, res);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).detail, /icon_d2_snapshot_invalid/);
});

test('handler serves stale cache when the refresh fails', async () => {
  clearCaches();
  const snap = fixtureSnapshot();
  const t0 = Date.parse('2026-09-27T00:10:00Z');
  const good = iconD2Proxy({
    fetchImpl: async () => snapshotResponse(snap),
    now: () => t0,
  });
  const callsGood = mount(good);
  const res1 = fakeRes();
  await callsGood[0].handler({ method: 'GET', url: '/api/icon-d2' }, res1);
  assert.equal(res1.statusCode, 200);

  const bad = iconD2Proxy({
    fetchImpl: async () => {
      throw abortError();
    },
    now: () => t0 + 4 * 3600_000, // past the 3 h TTL, inside the 12 h stale window
  });
  const callsBad = mount(bad);
  const res2 = fakeRes();
  await callsBad[0].handler({ method: 'GET', url: '/api/icon-d2' }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(JSON.parse(res2.body).stale, true);
});
