import assert from 'node:assert/strict';
import test from 'node:test';
import { createImageryTileLayer } from './factory.js';
import {
  GIBS_WMTS_BASE,
  RAINVIEWER_API_URL,
  GIBS_PRODUCTS,
  RAINVIEWER_PRODUCTS,
  yesterdayDateUTC,
  gibsTileTemplate,
  productUrlTemplate,
  createGibsSource,
  createRainViewerSource,
  normalizeRainViewerSnapshot,
} from './products.js';

const SIX_HOURS = 6 * 3600 * 1000;
const TEN_MINUTES = 10 * 60 * 1000;

/** Minimal viewer stand-in: only imageryLayers add/remove. */
function stubViewer() {
  const added = [];
  return {
    added,
    imageryLayers: {
      addImageryProvider(provider) {
        const imageryLayer = { provider, alpha: 1 };
        added.push(imageryLayer);
        return imageryLayer;
      },
      remove(imageryLayer) {
        const index = added.indexOf(imageryLayer);
        if (index >= 0) added.splice(index, 1);
      },
    },
  };
}

function staticSource(template) {
  return { getSnapshot: async () => ({ template }) };
}

test('yesterdayDateUTC returns yesterday in UTC', () => {
  assert.equal(
    yesterdayDateUTC(Date.parse('2026-09-26T12:00:00Z')),
    '2026-09-25',
  );
  // Just past UTC midnight still counts the previous UTC day.
  assert.equal(
    yesterdayDateUTC(Date.parse('2026-09-26T00:30:00Z')),
    '2026-09-25',
  );
  assert.match(yesterdayDateUTC(), /^\d{4}-\d{2}-\d{2}$/);
});

test('gibsTileTemplate builds the verified WMTS REST pattern', () => {
  assert.equal(
    gibsTileTemplate({
      layerName: 'MODIS_Terra_CorrectedReflectance_TrueColor',
      matrixSet: 'GoogleMapsCompatible_Level9',
      ext: 'jpg',
      date: '2026-09-25',
    }),
    `${GIBS_WMTS_BASE}/MODIS_Terra_CorrectedReflectance_TrueColor/default/2026-09-25/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`,
  );
  assert.throws(
    () =>
      gibsTileTemplate({
        layerName: 'x',
        matrixSet: 'y',
        ext: 'jpg',
        date: 'not-a-date',
      }),
    /date/,
  );
});

test('GIBS product configs carry the verified layer facts', () => {
  assert.deepEqual(Object.keys(GIBS_PRODUCTS).sort(), [
    'chlorophyll',
    'nightlights',
    'sst',
    'truecolor',
  ]);
  assert.equal(
    GIBS_PRODUCTS.truecolor.wmtsLayer,
    'MODIS_Terra_CorrectedReflectance_TrueColor',
  );
  assert.equal(
    GIBS_PRODUCTS.truecolor.matrixSet,
    'GoogleMapsCompatible_Level9',
  );
  assert.equal(GIBS_PRODUCTS.truecolor.ext, 'jpg');
  assert.equal(GIBS_PRODUCTS.nightlights.fixedDate, '2016-01-01');
  assert.equal(GIBS_PRODUCTS.nightlights.matrixSet, 'GoogleMapsCompatible_Level8');
  assert.equal(GIBS_PRODUCTS.chlorophyll.wmtsLayer, 'VIIRS_SNPP_L2_Chlorophyll_A');
  assert.equal(GIBS_PRODUCTS.sst.wmtsLayer, 'GHRSST_L4_MUR_Sea_Surface_Temperature');
  assert.equal(GIBS_PRODUCTS.sst.matrixSet, 'GoogleMapsCompatible_Level7');
  for (const product of Object.values(GIBS_PRODUCTS)) {
    assert.equal(product.updateInterval, SIX_HOURS);
    assert.equal(product.sourceLabel, 'NASA GIBS');
    const template = productUrlTemplate(product, Date.parse('2026-09-26T12:00:00Z'));
    assert.ok(
      template.includes(product.fixedDate || '2026-09-25'),
      template,
    );
  }
  assert.equal(Object.keys(RAINVIEWER_PRODUCTS).sort().join(','), 'radar,satellite');
  assert.equal(RAINVIEWER_PRODUCTS.radar.updateInterval, TEN_MINUTES);
  assert.equal(RAINVIEWER_PRODUCTS.satellite.updateInterval, TEN_MINUTES);
  assert.equal(productUrlTemplate(RAINVIEWER_PRODUCTS.radar), null);
});

test('GIBS source stamps the template date per snapshot', async () => {
  let nowMs = Date.parse('2026-09-26T12:00:00Z');
  const source = createGibsSource(GIBS_PRODUCTS.truecolor, {
    now: () => nowMs,
  });
  let snapshot = await source.getSnapshot({});
  assert.ok(snapshot.template.includes('/default/2026-09-25/'), snapshot.template);
  nowMs = Date.parse('2026-09-27T12:00:00Z');
  snapshot = await source.getSnapshot({});
  assert.ok(snapshot.template.includes('/default/2026-09-26/'), snapshot.template);
  const fixed = await createGibsSource(GIBS_PRODUCTS.nightlights).getSnapshot({});
  assert.ok(fixed.template.includes('/default/2016-01-01/'), fixed.template);
});

test('normalizeRainViewerSnapshot picks the latest radar frame', () => {
  const payload = {
    host: 'https://tilecache.rainviewer.com',
    radar: {
      past: [
        { time: 1790467800, path: '/v2/radar/aaa' },
        { time: 1790475000, path: '/v2/radar/bbb' },
      ],
      nowcast: [],
    },
    satellite: { infrared: [] },
  };
  const parsed = normalizeRainViewerSnapshot(payload, 'radar');
  assert.equal(parsed.ok, true);
  assert.equal(
    parsed.snapshot.template,
    'https://tilecache.rainviewer.com/v2/radar/bbb/256/{z}/{x}/{y}/2/1_1.png',
  );
  assert.equal(parsed.snapshot.frameTimeMs, 1790475000 * 1000);
  assert.equal(parsed.snapshot.maximumLevel, RAINVIEWER_PRODUCTS.radar.maximumLevel);
});

test('normalizeRainViewerSnapshot reports empty infrared as unavailable', () => {
  const parsed = normalizeRainViewerSnapshot(
    {
      host: 'https://tilecache.rainviewer.com',
      radar: { past: [] },
      satellite: { infrared: [] },
    },
    'satellite',
  );
  assert.equal(parsed.ok, false);
  assert.equal(parsed.unavailable, true);
  assert.match(parsed.error, /infrared/);
});

test('normalizeRainViewerSnapshot rejects malformed payloads', () => {
  for (const payload of [null, {}, { host: 'http://evil.example' }, { host: 'https://h.example' }]) {
    const parsed = normalizeRainViewerSnapshot(payload, 'radar');
    assert.equal(parsed.ok, false, JSON.stringify(payload));
  }
  const badFrames = normalizeRainViewerSnapshot(
    { host: 'https://tilecache.rainviewer.com', radar: { past: [{ time: 'x' }] } },
    'radar',
  );
  assert.equal(badFrames.ok, false);
  assert.equal(normalizeRainViewerSnapshot({ host: 'https://h.example' }, 'bogus').ok, false);
});

test('RainViewer source throws on HTTP errors and empty satellite feed', async () => {
  const httpDown = createRainViewerSource({
    kind: 'radar',
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(httpDown.getSnapshot({}), /503/);

  const emptySatellite = createRainViewerSource({
    kind: 'satellite',
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({
        host: 'https://tilecache.rainviewer.com',
        radar: { past: [] },
        satellite: { infrared: [] },
      }),
    }),
  });
  await assert.rejects(emptySatellite.getSnapshot({}), /infrared/);
  assert.equal(RAINVIEWER_API_URL, 'https://api.rainviewer.com/public/weather-maps.json');
});

test('factory validates its inputs', () => {
  assert.throws(() => createImageryTileLayer(), /id/);
  assert.throws(() => createImageryTileLayer({ id: 'x' }), /name/);
  assert.throws(
    () =>
      createImageryTileLayer({
        id: 'x',
        name: 'X',
        updateInterval: 1000,
      }),
    /snapshot source/,
  );
  assert.throws(
    () =>
      createImageryTileLayer({
        id: 'x',
        name: 'X',
        source: staticSource('t'),
        updateInterval: 0,
      }),
    /updateInterval/,
  );
});

test('factory lifecycle: init, enable attaches, update frames, disable detaches, destroy clears', async () => {
  const viewer = stubViewer();
  const layer = createImageryTileLayer({
    id: 'test-layer',
    name: 'Test Layer',
    icon: '🛰️',
    sourceLabel: 'Test',
    credit: 'test credit',
    urlTemplate: 'https://tiles.example/{z}/{x}/{y}.png',
    maximumLevel: 9,
    updateInterval: 1000,
    source: staticSource('https://tiles.example/{z}/{x}/{y}.png'),
  });
  assert.equal(layer.id, 'test-layer');
  assert.equal(layer.source, 'Test');
  assert.equal(layer.updateInterval, 1000);
  assert.throws(() => layer.enable(), /before init/);

  layer.init(viewer);
  assert.throws(() => layer.init(viewer), /already initialized/);
  layer.enable(viewer);
  // Static template attaches synchronously on enable.
  assert.equal(viewer.added.length, 1);
  assert.ok(viewer.added[0].provider.url.includes('tiles.example'));

  // update() with an unchanged template does not rebuild the provider.
  const first = viewer.added[0];
  assert.equal(await layer.update(viewer), true);
  assert.equal(viewer.added.length, 1);
  assert.equal(viewer.added[0], first);
  const stats = layer.getStats();
  assert.ok(stats.frames >= 1, JSON.stringify(stats));
  assert.ok(Number.isFinite(stats.updatedAt));
  assert.equal(stats.error, null);

  layer.disable(viewer);
  assert.equal(viewer.added.length, 0);
  // update() while disabled is a no-op.
  assert.equal(await layer.update(viewer), false);
  layer.destroy(viewer);
  assert.deepEqual(layer.getStats(), {
    frames: 0,
    updatedAt: null,
    error: null,
  });
});

test('factory rebuilds the provider only when the template changes', async () => {
  const viewer = stubViewer();
  let nowMs = Date.parse('2026-09-26T12:00:00Z');
  const layer = createImageryTileLayer({
    id: 'test-gibs',
    name: 'Test GIBS',
    icon: '🛰️',
    sourceLabel: 'NASA GIBS',
    credit: 'gibs',
    urlTemplate: null,
    maximumLevel: 9,
    updateInterval: 1000,
    source: createGibsSource(GIBS_PRODUCTS.truecolor, { now: () => nowMs }),
  });
  layer.init(viewer);
  layer.enable(viewer);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(viewer.added.length, 1);
  const first = viewer.added[0];
  assert.ok(first.provider.url.includes('/2026-09-25/'), first.provider.url);

  // Same date: no rebuild.
  assert.equal(await layer.update(viewer), true);
  assert.equal(viewer.added[0], first);

  // Midnight rollover: template changes, provider rebuilt.
  nowMs = Date.parse('2026-09-27T12:00:00Z');
  assert.equal(await layer.update(viewer), true);
  assert.equal(viewer.added.length, 1);
  assert.notEqual(viewer.added[0], first);
  assert.ok(viewer.added[0].provider.url.includes('/2026-09-26/'), viewer.added[0].provider.url);
  assert.equal(layer.getStats().frames, 3);
  layer.destroy(viewer);
  assert.equal(viewer.added.length, 0);
});

test('factory degrades to off with a clear error when the source is unavailable', async () => {
  const viewer = stubViewer();
  const unavailable = new Error('RainViewer satellite infrared feed empty');
  unavailable.unavailable = true;
  const layer = createImageryTileLayer({
    id: 'test-sat',
    name: 'Test Satellite',
    icon: '📡',
    sourceLabel: 'RainViewer',
    credit: 'rainviewer',
    urlTemplate: null,
    updateInterval: 1000,
    source: {
      getSnapshot: async () => {
        throw unavailable;
      },
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Stays off: nothing attached, error recorded, no fake frames.
  assert.equal(viewer.added.length, 0);
  assert.equal(layer.getStats().frames, 0);
  assert.match(layer.getStats().error, /infrared feed empty/);
  assert.equal(await layer.update(viewer), false);
  layer.destroy(viewer);
});

test('factory detaches on transient failure instead of showing stale tiles', async () => {
  const viewer = stubViewer();
  let fail = false;
  const layer = createImageryTileLayer({
    id: 'test-flaky',
    name: 'Test Flaky',
    icon: '🛰️',
    sourceLabel: 'Test',
    credit: 'c',
    urlTemplate: 'https://tiles.example/a/{z}/{x}/{y}.png',
    updateInterval: 1000,
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('boom');
        return { template: 'https://tiles.example/a/{z}/{x}/{y}.png' };
      },
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(viewer.added.length, 1);
  fail = true;
  assert.equal(await layer.update(viewer), false);
  assert.equal(viewer.added.length, 0);
  assert.match(layer.getStats().error, /boom/);
  layer.destroy(viewer);
});
