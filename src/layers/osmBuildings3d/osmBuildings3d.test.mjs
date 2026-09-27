import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  OSM_BUILDINGS_LAYER_ID,
  OSM_BUILDINGS_UPDATE_INTERVAL_MS,
  OSM_BUILDINGS_MAX_BUILDINGS,
  OSM_BUILDINGS_MAX_CAMERA_ALTITUDE_M,
  buildBuildingsQuery,
  parseBuildingHeight,
  halfDegForAltitude,
  clampViewBbox,
  shouldFetchForAltitude,
  parseBuildingsResponse,
  flattenFootprintPositions,
} from './model.js';
import {
  createOsmBuildings3dLayer,
  defaultQueryOverpass,
} from './index.js';

describe('osmBuildings3d model', () => {
  it('builds a bbox-bounded Overpass query', () => {
    const query = buildBuildingsQuery(37.77, -122.42, 37.78, -122.41);
    assert.match(query, /\[out:json\]\[timeout:20\]/);
    assert.match(
      query,
      /way\["building"\]\(37\.770000,-122\.420000,37\.780000,-122\.410000\)/,
    );
    assert.match(query, /out geom/);
    // Every selector carries the bbox (proxy sanitizer requirement).
    assert.ok(!query.includes(');('));
  });

  it('clamps the query timeout to the server cap', () => {
    assert.match(buildBuildingsQuery(0, 0, 1, 1, { timeoutSec: 99 }), /\[timeout:30\]/);
    assert.match(buildBuildingsQuery(0, 0, 1, 1, { timeoutSec: 5 }), /\[timeout:5\]/);
  });

  it('parses explicit height tags', () => {
    assert.equal(parseBuildingHeight({ height: '12' }), 12);
    assert.equal(parseBuildingHeight({ height: '12.5 m' }), 12.5);
    assert.equal(parseBuildingHeight({ height: 9 }), 9);
  });

  it('converts feet to metres', () => {
    assert.ok(Math.abs(parseBuildingHeight({ height: '100 ft' }) - 30.48) < 1e-9);
  });

  it('falls back to building:levels then the default', () => {
    assert.ok(
      Math.abs(parseBuildingHeight({ 'building:levels': '4' }) - 12.8) < 1e-9,
    );
    assert.equal(parseBuildingHeight({}), 10);
    assert.equal(parseBuildingHeight({ height: 'unknown' }), 10);
  });

  it('clamps absurd heights', () => {
    assert.equal(parseBuildingHeight({ height: '5000' }), 300);
    assert.equal(parseBuildingHeight({ height: '-5' }), 10);
  });

  it('scales the viewport half-size with altitude and clamps it', () => {
    const low = halfDegForAltitude(500);
    const high = halfDegForAltitude(20_000);
    assert.ok(low < high);
    assert.ok(halfDegForAltitude(0) >= 0.004);
    assert.ok(halfDegForAltitude(1e9) <= 0.15);
  });

  it('clamps the viewport bbox to valid geography', () => {
    const bbox = clampViewBbox(95, -200, 10);
    assert.ok(bbox.north <= 90);
    assert.ok(bbox.west >= -180);
    assert.ok(bbox.south < bbox.north);
    assert.ok(bbox.west < bbox.east);
  });

  it('skips refresh when the camera is too high', () => {
    assert.equal(shouldFetchForAltitude(10_000), true);
    assert.equal(
      shouldFetchForAltitude(OSM_BUILDINGS_MAX_CAMERA_ALTITUDE_M + 1),
      false,
    );
    assert.equal(shouldFetchForAltitude(Number.NaN), false);
  });

  it('parses an Overpass response into footprints', () => {
    const json = {
      elements: [
        {
          type: 'way',
          id: 1,
          tags: { building: 'yes', 'building:levels': '3' },
          geometry: [
            { lat: 37.77, lon: -122.42 },
            { lat: 37.77, lon: -122.41 },
            { lat: 37.78, lon: -122.41 },
            { lat: 37.78, lon: -122.42 },
            { lat: 37.77, lon: -122.42 },
          ],
        },
        { type: 'node', id: 2, lat: 37.77, lon: -122.42 },
        {
          type: 'way',
          id: 3,
          tags: { building: 'yes' },
          geometry: [
            { lat: 37.77, lon: -122.42 },
            { lat: 37.77, lon: -122.41 },
          ],
        },
      ],
    };
    const footprints = parseBuildingsResponse(json);
    assert.equal(footprints.length, 1);
    assert.equal(footprints[0].id, 'osm-building:1');
    assert.equal(footprints[0].positions.length, 4);
    assert.ok(
      Math.abs(footprints[0].height - 9.6) < 1e-9,
      '3 levels × 3.2 m',
    );
  });

  it('returns [] for malformed responses', () => {
    assert.deepEqual(parseBuildingsResponse(null), []);
    assert.deepEqual(parseBuildingsResponse({}), []);
    assert.deepEqual(parseBuildingsResponse({ elements: 'nope' }), []);
  });

  it('flattens footprint positions for fromDegreesArray', () => {
    assert.deepEqual(
      flattenFootprintPositions([
        [-122.42, 37.77],
        [-122.41, 37.78],
      ]),
      [-122.42, 37.77, -122.41, 37.78],
    );
  });
});

function makeViewer({ altitudeM = 2000 } = {}) {
  const added = [];
  return {
    viewer: {
      camera: {
        position: Cesium.Cartesian3.fromDegrees(-122.42, 37.77, altitudeM),
      },
      dataSources: {
        added,
        add(ds) {
          added.push(ds);
          return Promise.resolve(ds);
        },
        remove(ds) {
          const index = added.indexOf(ds);
          if (index >= 0) added.splice(index, 1);
        },
      },
    },
    added,
  };
}

function stubOverpassResponse() {
  return {
    elements: [
      {
        type: 'way',
        id: 42,
        tags: { building: 'apartments', height: '25' },
        geometry: [
          { lat: 37.7701, lon: -122.4201 },
          { lat: 37.7701, lon: -122.4199 },
          { lat: 37.7703, lon: -122.4199 },
          { lat: 37.7703, lon: -122.4201 },
          { lat: 37.7701, lon: -122.4201 },
        ],
      },
      {
        type: 'way',
        id: 43,
        tags: { building: 'house' },
        geometry: [
          { lat: 37.7711, lon: -122.4211 },
          { lat: 37.7711, lon: -122.4209 },
          { lat: 37.7713, lon: -122.4209 },
          { lat: 37.7713, lon: -122.4211 },
          { lat: 37.7711, lon: -122.4211 },
        ],
      },
    ],
  };
}

describe('osmBuildings3d layer lifecycle', () => {
  it('exposes the application-layer contract', () => {
    const layer = createOsmBuildings3dLayer({
      queryOverpass: async () => stubOverpassResponse(),
    });
    assert.equal(layer.id, OSM_BUILDINGS_LAYER_ID);
    assert.equal(layer.name, 'OSM 3D Buildings');
    assert.equal(layer.updateInterval, OSM_BUILDINGS_UPDATE_INTERVAL_MS);
    for (const method of ['init', 'enable', 'disable', 'update', 'destroy']) {
      assert.equal(typeof layer[method], 'function');
    }
  });

  it('enable() before init() is a safe no-op', () => {
    const layer = createOsmBuildings3dLayer({
      queryOverpass: async () => stubOverpassResponse(),
    });
    assert.doesNotThrow(() => layer.enable());
    assert.deepEqual(layer.getStatus(), { state: 'disabled' });
  });

  it('extrudes buildings on update and reports status', async () => {
    const { viewer, added } = makeViewer();
    const layer = createOsmBuildings3dLayer({
      queryOverpass: async () => stubOverpassResponse(),
    });
    layer.init(viewer);
    assert.equal(added.length, 1);
    layer.enable();
    const ok = await layer.update();
    assert.equal(ok, true);
    const entities = added[0].entities.values;
    assert.equal(entities.length, 2);
    assert.equal(entities[0].id, 'osm-building:42');
    assert.ok(entities[0].polygon);
    assert.equal(entities[0].polygon.extrudedHeight.getValue(), 25);
    assert.equal(entities[1].polygon.extrudedHeight.getValue(), 10);
    assert.equal(layer.getCount(), 2);
    const status = layer.getStatus();
    assert.equal(status.state, 'ok');
    assert.equal(status.count, 2);
  });

  it('skips the fetch while the camera is too high', async () => {
    const { viewer, added } = makeViewer({
      altitudeM: OSM_BUILDINGS_MAX_CAMERA_ALTITUDE_M * 2,
    });
    let calls = 0;
    const layer = createOsmBuildings3dLayer({
      queryOverpass: async () => {
        calls++;
        return stubOverpassResponse();
      },
    });
    layer.init(viewer);
    layer.enable();
    const ok = await layer.update();
    assert.equal(ok, false);
    assert.equal(calls, 0);
    assert.equal(added[0].entities.values.length, 0);
  });

  it('records an error status when Overpass fails', async () => {
    const { viewer } = makeViewer();
    const layer = createOsmBuildings3dLayer({
      queryOverpass: async () => {
        throw new Error('proxy exploded');
      },
    });
    layer.init(viewer);
    layer.enable();
    const ok = await layer.update();
    assert.equal(ok, false);
    const status = layer.getStatus();
    assert.equal(status.state, 'error');
    assert.match(status.message, /proxy exploded/);
  });

  it('disable() hides the datasource and clears entities', async () => {
    const { viewer, added } = makeViewer();
    const layer = createOsmBuildings3dLayer({
      queryOverpass: async () => stubOverpassResponse(),
    });
    layer.init(viewer);
    layer.enable();
    await layer.update();
    assert.equal(added[0].entities.values.length, 2);
    layer.disable();
    assert.equal(added[0].show, false);
    assert.equal(added[0].entities.values.length, 0);
    assert.deepEqual(layer.getStatus(), { state: 'disabled' });
  });

  it('destroy() removes the datasource', () => {
    const { viewer, added } = makeViewer();
    const layer = createOsmBuildings3dLayer({
      queryOverpass: async () => stubOverpassResponse(),
    });
    layer.init(viewer);
    layer.enable();
    layer.destroy(viewer);
    assert.equal(added.length, 0);
  });
});

describe('defaultQueryOverpass', () => {
  let originalFetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs URL-encoded QL to the app proxy', async () => {
    let seen;
    globalThis.fetch = async (url, init) => {
      seen = { url, init };
      return { ok: true, json: async () => ({ elements: [] }) };
    };
    const query = buildBuildingsQuery(1, 2, 3, 4);
    const result = await defaultQueryOverpass(query);
    assert.deepEqual(result, { elements: [] });
    assert.equal(seen.url, '/api/overpass');
    assert.equal(seen.init.method, 'POST');
    assert.equal(
      seen.init.headers['Content-Type'],
      'application/x-www-form-urlencoded',
    );
    assert.equal(seen.init.body, 'data=' + encodeURIComponent(query));
  });

  it('throws on proxy HTTP errors', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 429 });
    await assert.rejects(
      () => defaultQueryOverpass('data'),
      /Overpass HTTP 429/,
    );
  });
});

describe('osmBuildings3d safety rails', () => {
  it('never exceeds the entity cap', () => {
    const elements = [];
    for (let i = 0; i < OSM_BUILDINGS_MAX_BUILDINGS + 500; i++) {
      elements.push({
        type: 'way',
        id: i,
        tags: { building: 'yes' },
        geometry: [
          { lat: 37.77, lon: -122.42 },
          { lat: 37.77, lon: -122.41 },
          { lat: 37.78, lon: -122.41 },
          { lat: 37.78, lon: -122.42 },
          { lat: 37.77, lon: -122.42 },
        ],
      });
    }
    const footprints = parseBuildingsResponse({ elements });
    assert.equal(footprints.length, OSM_BUILDINGS_MAX_BUILDINGS);
  });
});
