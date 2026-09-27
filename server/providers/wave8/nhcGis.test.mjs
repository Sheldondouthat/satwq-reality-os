import assert from 'node:assert/strict';
import test from 'node:test';
import { nhcGisProxy, _nhcGisInternals } from './nhcGis.js';

const { parseStormId, parseNhcGisIndex, PARTIAL_REASON, clearCaches } =
  _nhcGisInternals;

// ——— harness ———

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

// ——— parser tests ———

test('parseStormId decomposes basin/storm/year', () => {
  assert.deepEqual(parseStormId('al062026'), {
    stormId: 'al062026',
    basin: 'Atlantic',
    stormNumber: 6,
    year: 2026,
  });
  assert.deepEqual(parseStormId('EP152026').basin, 'East Pacific');
  assert.equal(parseStormId('gtwo_shapefiles'), null);
});

test('parseNhcGisIndex filters examples and classifies kinds', () => {
  const html = [
    '<a href="/gis/examples/al112017_5day_020.zip">sample</a>',
    '<a href="forecast/archive/al062026_5day_latest.zip">cone</a>',
    '<a href="forecast/archive/ep152026_fcst_latest.zip">track</a>',
    '<a href="best_track/al062026_best_track.zip">best</a>',
    '<a href="/xgtwo/gtwo_shapefiles.zip">gtwo</a>',
  ].join('\n');
  const products = parseNhcGisIndex(html);
  assert.equal(products.length, 4);
  assert.ok(
    !products.some((p) => p.url.includes('examples')),
    'examples filtered out',
  );
  const cone = products.find((p) => p.kind === '5-day forecast cone');
  assert.ok(cone);
  assert.equal(cone.stormId, 'al062026');
  assert.equal(cone.basin, 'Atlantic');
  assert.equal(cone.year, 2026);
  assert.ok(cone.url.startsWith('https://www.nhc.noaa.gov/gis/'));
  const gtwo = products.find((p) => p.filename === 'gtwo_shapefiles.zip');
  assert.equal(gtwo.stormId, null);
});

test('parseNhcGisIndex dedupes and sorts', () => {
  const html =
    '<a href="best_track/al062026_best_track.zip">a</a><a href="best_track/al062026_best_track.zip">b</a>';
  const products = parseNhcGisIndex(html);
  assert.equal(products.length, 1);
});

// ——— handler tests ———

const INDEX_HTML = [
  '<html><body>',
  '<a href="forecast/archive/al062026_5day_latest.zip">cone</a>',
  '<a href="best_track/al062026_best_track.zip">best</a>',
  '</body></html>',
].join('\n');

const indexResponse = () => ({
  ok: true,
  status: 200,
  headers: { get: () => null },
  text: async () => INDEX_HTML,
});

test('handler mounts /api/nhc-gis and always labels partial (redirect:follow)', async () => {
  clearCaches();
  const seen = [];
  const provider = nhcGisProxy({
    fetchImpl: async (url, opts) => {
      seen.push([url, opts]);
      return indexResponse();
    },
  });
  const calls = mount(provider);
  assert.equal(calls[0].route, '/api/nhc-gis');
  assert.equal(calls[0].route, calls[2]?.route ?? calls[0].route);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/nhc-gis' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(seen[0][1].redirect, 'follow');
  const body = JSON.parse(res.body);
  assert.equal(body.partial, true);
  assert.equal(body.partialReason, PARTIAL_REASON);
  assert.equal(body.productCount, 2);
  assert.equal(body.products[0].kind, 'best track');
});

test('handler 502s honestly when the index is unreachable (no cache)', async () => {
  clearCaches();
  const abortError = () =>
    Object.assign(new Error('The operation was aborted'), {
      name: 'AbortError',
    });
  const provider = nhcGisProxy({
    fetchImpl: async () => {
      throw abortError();
    },
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/nhc-gis' }, res);
  assert.equal(res.statusCode, 502);
});

test('handler 502s when the index holds no zip links', async () => {
  clearCaches();
  const provider = nhcGisProxy({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => '<html><body>no links</body></html>',
    }),
  });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/nhc-gis' }, res);
  assert.equal(res.statusCode, 502);
});

test('handler serves stale cache when the refresh fails', async () => {
  clearCaches();
  const now0 = Date.parse('2026-09-27T20:00:00Z');
  const provider = nhcGisProxy({
    fetchImpl: async () => indexResponse(),
    now: () => now0,
  });
  const calls = mount(provider);
  const res1 = fakeRes();
  await calls[0].handler({ method: 'GET', url: '/api/nhc-gis' }, res1);
  assert.equal(res1.statusCode, 200);

  const provider2 = nhcGisProxy({
    fetchImpl: async () => {
      throw Object.assign(new Error('boom'), { status: 502 });
    },
    now: () => now0 + 31 * 60_000, // past the 30-min TTL, inside the 6h stale window
  });
  // NOTE: module-level cache is shared; the failed refresh must serve stale.
  const calls2 = mount(provider2);
  const res2 = fakeRes();
  await calls2[0].handler({ method: 'GET', url: '/api/nhc-gis' }, res2);
  assert.equal(res2.statusCode, 200);
  assert.equal(JSON.parse(res2.body).stale, true);
  assert.equal(JSON.parse(res2.body).partial, true);
  clearCaches();
});

test('handler rejects non-GET with 405', async () => {
  clearCaches();
  const provider = nhcGisProxy({ fetchImpl: async () => indexResponse() });
  const calls = mount(provider);
  const res = fakeRes();
  await calls[0].handler({ method: 'POST', url: '/api/nhc-gis' }, res);
  assert.equal(res.statusCode, 405);
});
