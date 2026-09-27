import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createHmsSmokeLayer, SMOKE_DENSITY_STYLE } from './index.js';
import { createHmsSmokeSource } from './source.js';
import { parseSmokeKml } from './records.js';

function placemark(style, coords) {
  return (
    `<Placemark><name>smoke</name><styleUrl>#${style}</styleUrl>` +
    `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords}</coordinates>` +
    `</LinearRing></outerBoundaryIs></Polygon></Placemark>`
  );
}

const RING_A = '-120.0,40.0,0 -119.0,40.0,0 -119.0,41.0,0 -120.0,41.0,0 -120.0,40.0,0';
const RING_B = '-100.0,35.0,0 -99.0,35.0,0 -99.0,36.0,0 -100.0,36.0,0 -100.0,35.0,0';
const RING_C = '-80.0,30.0,0 -79.0,30.0,0 -79.0,31.0,0 -80.0,31.0,0 -80.0,30.0,0';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document>
<Style id="Smoke_Light"><PolyStyle><color>7d00ffff</color></PolyStyle></Style>
<Style id="Smoke_Moderate"><PolyStyle><color>7d00a5ff</color></PolyStyle></Style>
<Style id="Smoke_Heavy"><PolyStyle><color>7d0000ff</color></PolyStyle></Style>
${placemark('Smoke_Light', RING_A)}
${placemark('Smoke_Moderate', RING_B)}
${placemark('Smoke_Heavy', RING_C)}
<Placemark><name>broken</name><styleUrl>#Smoke_Light</styleUrl><Polygon><outerBoundaryIs><LinearRing><coordinates></coordinates></LinearRing></outerBoundaryIs></Polygon></Placemark>
</Document></kml>`;

test('parseSmokeKml maps the three HMS densities and skips malformed placemarks', () => {
  const records = parseSmokeKml(FIXTURE);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => r.density),
    ['light', 'moderate', 'heavy'],
  );
  assert.deepEqual(records[0].ring, [
    [-120.0, 40.0],
    [-119.0, 40.0],
    [-119.0, 41.0],
    [-120.0, 41.0],
    [-120.0, 40.0],
  ]);
});

test('parseSmokeKml rejects non-KML and skips bad rings', () => {
  assert.throws(() => parseSmokeKml('not kml at all'), /not a KML/);
  assert.throws(() => parseSmokeKml(null), /not a KML/);
  const badCoords = `<?xml version="1.0"?><kml><Document>${placemark('Smoke_Heavy', 'abc,def,0 -79.0,30.0,0')}</Document></kml>`;
  assert.deepEqual(parseSmokeKml(badCoords), []);
  const unclosed = `<?xml version="1.0"?><kml><Document>${placemark('Smoke_Light', '-80.0,30.0,0 -79.0,30.0,0')}</Document></kml>`;
  assert.deepEqual(parseSmokeKml(unclosed), []);
  const outOfRange = `<?xml version="1.0"?><kml><Document>${placemark('Smoke_Moderate', '-999.0,30.0,0 -79.0,30.0,0 -79.0,31.0,0 -80.0,31.0,0 -80.0,30.0,0')}</Document></kml>`;
  assert.deepEqual(parseSmokeKml(outOfRange), []);
});

test('parseSmokeKml enforces the polygon cap', () => {
  const many = Array.from({ length: 500 }, (_, i) =>
    placemark('Smoke_Light', `${-120 - i * 0.001},40.0,0 ${-119 - i * 0.001},40.0,0 ${-119 - i * 0.001},41.0,0 ${-120 - i * 0.001},41.0,0 ${-120 - i * 0.001},40.0,0`),
  ).join('');
  const kml = `<?xml version="1.0"?><kml><Document>${many}</Document></kml>`;
  assert.equal(parseSmokeKml(kml).length, 400);
  assert.equal(parseSmokeKml(kml, { maxPolygons: 5 }).length, 5);
  // Regression: a capped parse must not poison subsequent parses
  // (global regex lastIndex). The fixture still yields all 3 after a cap hit.
  assert.equal(parseSmokeKml(FIXTURE).length, 3);
});

test('source returns {fetchedAt, polygons} and throws on 503 / malformed', async () => {
  const ok = createHmsSmokeSource({
    fetchImpl: async () => ({ ok: true, text: async () => FIXTURE }),
  });
  const snap = await ok.getSnapshot();
  assert.ok(Number.isFinite(snap.fetchedAt));
  assert.equal(snap.polygons.length, 3);

  const gone = createHmsSmokeSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(gone.getSnapshot(), /503/);

  const junk = createHmsSmokeSource({
    fetchImpl: async () => ({ ok: true, text: async () => 'garbage' }),
  });
  await assert.rejects(junk.getSnapshot(), /Malformed/);
});

test('density style colors match the spec (yellow/orange/red alphas)', () => {
  assert.equal(SMOKE_DENSITY_STYLE.light.alpha, 0.25);
  assert.equal(SMOKE_DENSITY_STYLE.moderate.alpha, 0.35);
  assert.equal(SMOKE_DENSITY_STYLE.heavy.alpha, 0.45);
  assert.deepEqual(
    SMOKE_DENSITY_STYLE.light.color.toCssColorString(),
    Cesium.Color.YELLOW.toCssColorString(),
  );
  assert.deepEqual(
    SMOKE_DENSITY_STYLE.moderate.color.toCssColorString(),
    Cesium.Color.ORANGE.toCssColorString(),
  );
  assert.deepEqual(
    SMOKE_DENSITY_STYLE.heavy.color.toCssColorString(),
    Cesium.Color.RED.toCssColorString(),
  );
});

function harness(source) {
  const sources = [];
  const viewer = {
    dataSources: {
      add(value) {
        sources.push(value);
      },
      remove(value) {
        sources.splice(sources.indexOf(value), 1);
      },
    },
  };
  const layer = createHmsSmokeLayer({ source });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources };
}

test('layer shape, lifecycle, and soft failure', async () => {
  const h = harness({
    getSnapshot: async () => ({
      fetchedAt: Date.now(),
      polygons: parseSmokeKml(FIXTURE),
    }),
  });
  assert.equal(h.layer.id, 'hms-smoke');
  assert.equal(h.layer.name, 'Wildfire Smoke');
  assert.equal(h.layer.icon, '🌫️');
  assert.equal(h.layer.source, 'NOAA HMS');
  assert.equal(h.layer.updateInterval, 3600_000);

  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.count, 3);
  assert.ok(Number.isFinite(stats.updatedAt));
  assert.equal(stats.error, null);
  assert.equal(h.sources[0].entities.values.length, 3);
  h.layer.disable(h.viewer);
  assert.equal(await h.layer.update(h.viewer), false);
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);

  const failing = harness({
    getSnapshot: async () => {
      throw new Error('hms down');
    },
  });
  assert.equal(await failing.layer.update(failing.viewer), false);
  assert.match(failing.layer.getStats().error, /hms down/);
});

test('layer requires a snapshot source and rejects double init', () => {
  assert.throws(() => createHmsSmokeLayer({}), /snapshot source/);
  const h = harness({ getSnapshot: async () => ({ polygons: [] }) });
  assert.throws(() => h.layer.init(h.viewer), /already initialized/);
});
