import assert from 'node:assert/strict';
import test from 'node:test';
import { tecProxy, _tecInternals } from './tec.js';

const {
  SNAPSHOT_URL,
  parseGloTecGeoJson,
  downsampleTec,
  computeTecStats,
  buildTecSnapshot,
  validateTecSnapshot,
  clearCaches,
} = _tecInternals;

// ——— fixtures ———

// 4 lons x 3 lats, lon-major order (like SWPC publishes), deterministic values.
function smallFixturePoints() {
  const lons = [-10, -5, 0, 5];
  const lats = [-2.5, 0, 2.5];
  const points = [];
  for (let r = 0; r < lats.length; r++) {
    for (let c = 0; c < lons.length; c++) {
      points.push({
        lon: lons[c],
        lat: lats[r],
        tec: 10 + c + r,
        anomaly: c - r,
        hmF2: 300 + 10 * c,
        nmF2: 1e11 + 1e9 * c,
        quality: 0,
      });
    }
  }
  return points;
}

function pointsToGeoJson(points) {
  return JSON.stringify({
    type: 'FeatureCollection',
    features: points.map((p) => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
      properties: { tec: p.tec, anomaly: p.anomaly, hmF2: p.hmF2, NmF2: p.nmF2, quality_flag: p.quality },
    })),
  });
}

// 40x40 = 1600 points, clears the 1000-point floor in parseGloTecGeoJson.
function bigFixtureGeoJson() {
  const points = [];
  for (let r = 0; r < 40; r++) {
    for (let c = 0; c < 40; c++) {
      points.push({
        lon: -180 + c * 9,
        lat: -88 + r * 4.5,
        tec: 5 + 0.1 * c + 0.05 * r,
        anomaly: 0.1 * c - 0.1 * r,
        hmF2: 300 + c,
        nmF2: 2e11 + 1e8 * r,
        quality: 0,
      });
    }
  }
  return pointsToGeoJson(points);
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
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
    once() {}, removeListener() {},
  };
  return res;
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

// ——— parser / builder unit tests ———

test('parseGloTecGeoJson parses a 1600-point fixture', () => {
  const { pointCount, points } = parseGloTecGeoJson(bigFixtureGeoJson());
  assert.equal(pointCount, 1600);
  assert.equal(points.length, 1600);
  assert.equal(points[0].lon, -180);
  assert.ok(Number.isFinite(points[1599].nmF2));
});

test('parseGloTecGeoJson rejects garbage and degenerate files', () => {
  assert.throws(() => parseGloTecGeoJson('not json'), /tec_geojson_invalid/);
  assert.throws(() => parseGloTecGeoJson('{}'), /tec_geojson_invalid/);
  assert.throws(() => parseGloTecGeoJson(pointsToGeoJson(smallFixturePoints())), /only 12 valid points/);
  const bad = JSON.parse(pointsToGeoJson(smallFixturePoints()));
  for (const f of bad.features) delete f.properties.tec;
  assert.throws(() => parseGloTecGeoJson(JSON.stringify(bad)), /only 0 valid points/);
});

test('downsampleTec strides rows and columns (2x2 on 4x3 grid → 4 pts)', () => {
  const down = downsampleTec(smallFixturePoints(), 2, 2, 1);
  assert.equal(down.gridPoints, 4);
  assert.deepEqual(down.grid.lon, [-10, 0, -10, 0]);
  assert.deepEqual(down.grid.lat, [-2.5, -2.5, 2.5, 2.5]);
  assert.deepEqual(down.grid.tec, [10, 12, 12, 14]);
  assert.deepEqual(down.grid.anomaly, [0, 2, -2, 0]);
  assert.deepEqual(down.grid.hmF2, [300, 320, 300, 320]);
});

test('computeTecStats summarizes the full point set', () => {
  const s = computeTecStats(smallFixturePoints());
  assert.equal(s.count, 12);
  assert.deepEqual(s.tec, { min: 10, max: 15, mean: 12.5, median: 12.5 });
  assert.equal(s.anomaly.min, -2);
  assert.equal(s.anomaly.max, 3);
  assert.equal(s.anomaly.mean, 0.5);
  assert.equal(s.hmF2.mean, 315);
  assert.equal(s.qualityFlags['0'], 12);
});

test('buildTecSnapshot produces a valid snapshot document', () => {
  const snap = buildTecSnapshot(bigFixtureGeoJson(), {
    upstreamFile: 'glotec_icao_20260927T205500Z.geojson',
    upstreamUrl: 'https://example.invalid/glotec_icao_20260927T205500Z.geojson',
    fetchedAt: '2026-09-27T21:35:00.000Z',
  });
  assert.equal(snap.format, 'glotec-snapshot');
  assert.equal(snap.formatVersion, 1);
  assert.equal(snap.upstreamFile, 'glotec_icao_20260927T205500Z.geojson');
  assert.equal(snap.pointCount, 1600);
  assert.equal(snap.gridPoints, 400); // 20x20 after 2x2 stride
  assert.ok(validateTecSnapshot(snap));
});

test('validateTecSnapshot rejects malformed snapshots', () => {
  assert.throws(() => validateTecSnapshot({}), /tec_snapshot_invalid/);
  const snap = buildTecSnapshot(bigFixtureGeoJson(), {
    upstreamFile: 'x.geojson', upstreamUrl: 'https://example.invalid/x', fetchedAt: new Date().toISOString(),
  });
  const truncated = { ...snap, grid: { ...snap.grid, tec: snap.grid.tec.slice(0, 10) } };
  assert.throws(() => validateTecSnapshot(truncated), /differ in length/);
  const noStats = { ...snap };
  delete noStats.stats;
  assert.throws(() => validateTecSnapshot(noStats), /stats missing/);
});

// ——— handler tests ———

function abortError() {
  const e = new Error('The operation was aborted');
  e.name = 'AbortError';
  return e;
}

test('handler mounts /api/tec and serves the snapshot (redirect:follow)', async () => {
  clearCaches();
  const snap = buildTecSnapshot(bigFixtureGeoJson(), {
    upstreamFile: 'glotec_icao_20260927T205500Z.geojson',
    upstreamUrl: 'https://example.invalid/x.geojson',
    fetchedAt: '2026-09-27T21:35:00.000Z',
  });
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url, options });
    return snapshotResponse(snap);
  };
  const provider = tecProxy({ fetchImpl, now: () => Date.parse('2026-09-27T21:40:00Z') });
  const calls = mount(provider);
  assert.deepEqual(calls.map((c) => c.route), ['/api/tec', '/api/tec']);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/tec' }, res);
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.stale, false);
  assert.equal(body.snapshot.upstreamFile, 'glotec_icao_20260927T205500Z.geojson');
  assert.equal(body.snapshot.gridPoints, 400);
  assert.equal(body.stats.count, 1600);
  assert.equal(body.grid.tec.length, 400);
  assert.ok(body.attribution.includes('NOAA SWPC'));
  assert.equal(seen[0].url, SNAPSHOT_URL);
  assert.ok(seen.every((x) => x.options.redirect === 'follow'));
});

test('handler 502s honestly when the snapshot is unreachable (no cache)', async () => {
  clearCaches();
  const provider = tecProxy({ fetchImpl: async () => { throw abortError(); } });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/tec' }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.parse(res.body).error, 'tec_unavailable');
});

test('handler 502s on a corrupt snapshot asset', async () => {
  clearCaches();
  const provider = tecProxy({ fetchImpl: async () => snapshotResponse({ format: 'nope' }) });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/tec' }, res);
  assert.equal(res.statusCode, 502);
  assert.match(JSON.parse(res.body).detail, /tec_snapshot_invalid/);
});

test('handler serves stale cache when the refresh fails', async () => {
  clearCaches();
  const snap = buildTecSnapshot(bigFixtureGeoJson(), {
    upstreamFile: 'glotec_icao_20260927T205500Z.geojson',
    upstreamUrl: 'https://example.invalid/x.geojson',
    fetchedAt: '2026-09-27T21:35:00.000Z',
  });
  let fail = false;
  const t0 = Date.parse('2026-09-27T21:40:00Z');
  const provider = tecProxy({
    fetchImpl: async () => {
      if (fail) throw abortError();
      return snapshotResponse(snap);
    },
    now: () => t0,
  });
  const calls = mount(provider);
  const res1 = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/tec' }, res1);
  assert.equal(JSON.parse(res1.body).stale, false);
  // 11 min later: cache expired, upstream down → stale serve
  fail = true;
  const provider2 = tecProxy({
    fetchImpl: async () => { throw abortError(); },
    now: () => t0 + 11 * 60_000,
  });
  const calls2 = mount(provider2);
  const res2 = fakeRes();
  await calls2[0].handler({ method: 'GET', url: '/api/tec' }, res2);
  assert.equal(res2.statusCode, 200);
  const body2 = JSON.parse(res2.body);
  assert.equal(body2.stale, true);
  assert.equal(body2.snapshot.upstreamFile, 'glotec_icao_20260927T205500Z.geojson');
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const snap = buildTecSnapshot(bigFixtureGeoJson(), {
    upstreamFile: 'x.geojson', upstreamUrl: 'https://example.invalid/x', fetchedAt: new Date().toISOString(),
  });
  const calls = mount(tecProxy({ fetchImpl: async () => snapshotResponse(snap) }));
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/tec' }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(JSON.parse(res.body).error, 'method_not_allowed');
});
