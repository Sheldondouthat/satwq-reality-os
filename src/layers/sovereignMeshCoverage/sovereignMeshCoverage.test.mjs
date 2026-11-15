/**
 * Sovereign Mesh (coverage) layer tests (BM3 §5 follow-on). The
 * coverage compute is exercised against its reference implementation
 * — the Phase-0 placement run (placement.py) published verdicts over
 * this same terrain grid, and the JS port must reproduce them — and
 * at the level the falsifier can reach in this suite: the replay
 * node set produces the deterministic coverage raster, every cell
 * description carries the coverage attribution verbatim and the
 * snapshot's SYNTHETIC label unupgraded, the layer is default-off,
 * and the unavailable envelope renders as an honest empty state.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSovereignMeshCoverageLayer } from './index.js';
import {
  BUNDLED_TERRAIN_GRID,
  computeCoverage,
  elevationAt,
  linkVerdict,
  nodeAntennaAltM,
} from './coverage.js';
import {
  COVERAGE_FILL_ALPHA,
  SOVEREIGN_MESH_COVERAGE_ATTRIBUTION,
  coverageCellDescription,
  coverageColorHex,
} from './model.js';
import { MARGIN_STYLES } from '../sovereignMesh/model.js';
import { normalizeSovereignMeshPayload } from '../sovereignMesh/records.js';

// The bridge's replay product (feed_records.json, 2026-11-15),
// verbatim node records: SYNTHETIC demo nodes at the operator's
// real anchor coordinates.
const replayPayload = (overrides = {}) => ({
  feed: 'Sovereign Mesh (nodes)',
  generated_at: '2026-11-15T03:44:33.654767+00:00',
  source: 'replay:sample_mqtt.jsonl',
  label: 'SYNTHETIC',
  confidence: 'Modeled',
  terrain_grid: 'fine (sovereign-mesh/elevation_grid_fine.json)',
  records_reference_epoch: 1763177420,
  nodes: [
    {
      id: '!aa000001',
      label: 'SYNTHETIC',
      last_heard_age_s: 60,
      name: 'SOV-DEMO Home Base',
      shortname: 'HOME',
      hardware: 'HELTEC_V3',
      role: 'CLIENT',
      lat: 37.3186,
      lon: -80.6297,
      altitude_m_reported: 615,
      battery_level: 101,
      voltage: 5.02,
      air_util_tx: 0.42,
      channel_utilization: 3.1,
      ground_elev_m_srtm: 546.8,
    },
    {
      id: '!aa000002',
      label: 'SYNTHETIC',
      last_heard_age_s: 0,
      name: 'SOV-DEMO Ridge Relay North',
      shortname: 'RDGN',
      hardware: 'RAK4631',
      role: 'ROUTER',
      lat: 37.37,
      lon: -80.6209,
      altitude_m_reported: 1282,
      battery_level: 87,
      voltage: 4.05,
      air_util_tx: 1.05,
      channel_utilization: 5.4,
      ground_elev_m_srtm: 1275.1,
    },
    {
      id: '!aa000003',
      label: 'SYNTHETIC',
      last_heard_age_s: 240,
      name: 'SOV-DEMO Mobile',
      shortname: 'MOBL',
      hardware: 'TBEAM',
      role: 'CLIENT',
      lat: 37.3296,
      lon: -80.6923,
      altitude_m_reported: 552,
      ground_elev_m_srtm: 577.6,
    },
  ],
  links: [],
  ...overrides,
});

const replaySnapshot = () =>
  normalizeSovereignMeshPayload(replayPayload());

test('linkVerdict reproduces the placement run on real terrain (reference cross-check)', () => {
  // PLACEMENT.md link table, computed by placement.py from this grid
  // with its antenna assumptions (HOME 10 m mast, relays 6 m, mobile
  // 2 m over the grid elevation at the node). The JS port must land
  // on the same verdicts and the same printed numbers.
  const grid = BUNDLED_TERRAIN_GRID;
  const ant = (lat, lon, h) => elevationAt(grid, lat, lon) + h;
  const home = {
    lat: 37.3186,
    lon: -80.6297,
    antennaAltM: ant(37.3186, -80.6297, 10),
  };
  const mobl = {
    lat: 37.3296,
    lon: -80.6923,
    antennaAltM: ant(37.3296, -80.6923, 2),
  };
  const blocked = linkVerdict(grid, home, mobl);
  assert.equal(blocked.verdict, 'BLOCKED');
  assert.equal(blocked.marginClass, 'none');
  assert.ok(Math.abs(blocked.minClearM - -44.5) < 0.6, 'min clearance');
  assert.ok(Math.abs(blocked.minFresnelMarginM - -57.4) < 0.6, 'fresnel');
  assert.ok(Math.abs(blocked.distKm - 5.67) < 0.05, 'distance');

  const ridge4 = {
    lat: 37.3445,
    lon: -80.60267,
    antennaAltM: ant(37.3445, -80.60267, 6),
  };
  const clear = linkVerdict(grid, home, ridge4);
  assert.equal(clear.verdict, 'CLEAR');
  assert.equal(clear.marginClass, 'strong');
  assert.ok(Math.abs(clear.minClearM - 10.8) < 0.6, 'min clearance');
  assert.ok(Math.abs(clear.minFresnelMarginM - 8.3) < 0.6, 'fresnel');
});

test('linkVerdict classifies the synthetic geometries and refuses the unknowable', () => {
  const flat = {
    lats: [37.0, 37.3],
    lons: [-80.95, -80.45],
    elevationsM: [
      [500, 500],
      [500, 500],
    ],
  };
  const high = (lon) => ({ lat: 37.05, lon, antennaAltM: 1500 });
  const strong = linkVerdict(flat, high(-80.85), high(-80.75));
  assert.equal(strong.verdict, 'CLEAR');
  assert.equal(strong.marginClass, 'strong'); // excess >= 40 dB
  const workable = linkVerdict(flat, high(-80.85), high(-80.55));
  assert.equal(workable.verdict, 'CLEAR');
  assert.equal(workable.marginClass, 'workable'); // CLEAR but excess < 40 dB
  assert.ok(workable.fsplExcessDb < 40);

  const ridge = {
    lats: [37.0, 37.1, 37.2],
    lons: [-80.8, -80.7, -80.6],
    elevationsM: [
      [500, 500, 500],
      [500, 545, 500],
      [500, 500, 500],
    ],
  };
  const grazed = linkVerdict(
    ridge,
    { lat: 37.1, lon: -80.79, antennaAltM: 560 },
    { lat: 37.1, lon: -80.61, antennaAltM: 560 },
  );
  assert.equal(grazed.verdict, 'GRAZED');
  assert.equal(grazed.marginClass, 'marginal');
  assert.ok(grazed.minClearM > 0 && grazed.minFresnelMarginM < 0);
  const blocked = linkVerdict(
    ridge,
    { lat: 37.1, lon: -80.79, antennaAltM: 520 },
    { lat: 37.1, lon: -80.61, antennaAltM: 520 },
  );
  assert.equal(blocked.verdict, 'BLOCKED');
  assert.equal(blocked.marginClass, 'none');

  const same = linkVerdict(flat, high(-80.85), high(-80.85));
  assert.equal(same.verdict, 'CLEAR');
  assert.equal(same.distKm, 0);
  // A path leaving the terrain grid is uncomputable, never guessed.
  assert.equal(
    linkVerdict(flat, high(-80.85), { lat: 38.5, lon: -80.55, antennaAltM: 1 }),
    null,
  );
});

test('elevationAt interpolates bilinearly and returns null outside the grid', () => {
  const grid = {
    lats: [37.0, 37.1],
    lons: [-80.8, -80.7],
    elevationsM: [
      [100, 200],
      [300, 400],
    ],
  };
  assert.equal(elevationAt(grid, 37.0, -80.8), 100);
  assert.ok(Math.abs(elevationAt(grid, 37.05, -80.75) - 250) < 1e-6);
  assert.equal(elevationAt(grid, 37.2, -80.75), null);
  assert.equal(elevationAt(grid, 37.05, -80.6), null);
});

test('nodeAntennaAltM takes the record as given: reported, then ground, then grid', () => {
  const grid = BUNDLED_TERRAIN_GRID;
  assert.equal(
    nodeAntennaAltM(grid, { altitudeM: 615, groundElevMSrtm: 546.8 }),
    615,
  );
  assert.equal(
    nodeAntennaAltM(grid, { altitudeM: null, groundElevMSrtm: 546.8 }),
    546.8,
  );
  const fromGrid = nodeAntennaAltM(grid, {
    altitudeM: null,
    groundElevMSrtm: null,
    lat: 37.3186,
    lon: -80.6297,
  });
  assert.ok(Math.abs(fromGrid - 546.8) < 1.5);
  assert.equal(
    nodeAntennaAltM(grid, {
      altitudeM: null,
      groundElevMSrtm: null,
      lat: 0,
      lon: 0,
    }),
    null,
  );
});

test('computeCoverage over the replay set yields the deterministic raster', () => {
  // Pinned to the bundled grid + the replay node set: if either the
  // terrain bundle or the compute changes, this count must move
  // loudly, not drift.
  const { cells, skippedNodes } = computeCoverage(replaySnapshot().nodes);
  assert.equal(skippedNodes, 0);
  assert.equal(cells.length, 1269);
  const byClass = { strong: 0, workable: 0, marginal: 0 };
  const ids = new Set(['!aa000001', '!aa000002', '!aa000003']);
  for (const cell of cells) {
    byClass[cell.marginClass] += 1;
    assert.ok(ids.has(cell.bestNodeId));
    assert.notEqual(cell.verdict, 'BLOCKED'); // blocked cells are absent
    assert.equal(cell.corners.length, 4);
  }
  assert.deepEqual(byClass, { strong: 855, workable: 0, marginal: 414 });
});

test("a node's own ground is covered, via itself, at full strength", () => {
  const { cells } = computeCoverage(replaySnapshot().nodes);
  let nearest = null;
  for (const cell of cells) {
    const d = Math.hypot(cell.lat - 37.3186, cell.lon - -80.6297);
    if (!nearest || d < nearest.d) nearest = { cell, d };
  }
  assert.equal(nearest.cell.bestShortname, 'HOME');
  assert.equal(nearest.cell.marginClass, 'strong');
  assert.ok(nearest.cell.distKm < 0.1);
});

test('computeCoverage with no usable nodes computes nothing, honestly', () => {
  assert.deepEqual(computeCoverage([]), { cells: [], skippedNodes: 0 });
  const offGrid = computeCoverage([
    { id: '!x', shortname: 'X', lat: 0, lon: 0, altitudeM: null, groundElevMSrtm: null },
  ]);
  assert.equal(offGrid.cells.length, 0);
  assert.equal(offGrid.skippedNodes, 1);
});

test('cell descriptions carry the label, the numbers, and the attribution verbatim', () => {
  const snap = replaySnapshot();
  const { cells } = computeCoverage(snap.nodes);
  const html = coverageCellDescription(cells[0], snap);
  assert.ok(html.includes('SYNTHETIC'));
  assert.ok(html.includes('replay:sample_mqtt.jsonl'));
  assert.ok(html.includes('Modeled'));
  assert.ok(html.includes(SOVEREIGN_MESH_COVERAGE_ATTRIBUTION));
  assert.equal(
    SOVEREIGN_MESH_COVERAGE_ATTRIBUTION,
    'Sovereign Mesh coverage — computed locally from SRTM terrain (OpenTopoData) and the operator\'s own node set. Modeled, not measured.',
  );
});

test('coverage colors are the mesh family margin palette, one legend', () => {
  for (const cls of ['strong', 'workable', 'marginal']) {
    assert.equal(coverageColorHex(cls), MARGIN_STYLES[cls].colorHex);
  }
  assert.ok(COVERAGE_FILL_ALPHA > 0 && COVERAGE_FILL_ALPHA < 1);
});

function fakeViewer() {
  const added = [];
  return {
    added,
    dataSources: {
      add: (ds) => added.push(ds),
      remove: () => {},
    },
  };
}

test('FALSIFIER: coverage renders from the replay set, labeled SYNTHETIC, default off', async () => {
  const layer = createSovereignMeshCoverageLayer({
    source: { getSnapshot: async () => replaySnapshot() },
  });
  assert.equal(layer.id, 'sovereign-mesh-coverage');
  const viewer = fakeViewer();
  layer.init(viewer);
  const dataSource = viewer.added[0];
  assert.equal(dataSource.show, false); // enabledByDefault: false
  assert.equal(await layer.update(viewer), false); // no fetch while disabled
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);

  const now = Cesium.JulianDate.now();
  const entities = dataSource.entities.values;
  assert.equal(entities.length, 1269);
  for (const e of entities.slice(0, 25)) {
    assert.ok(e.polygon, 'cell is a ground polygon');
    assert.equal(e.properties.feedLabel.getValue(now), 'SYNTHETIC');
    assert.ok(
      e.description.getValue(now).includes(SOVEREIGN_MESH_COVERAGE_ATTRIBUTION),
    );
  }
  const stats = layer.getStats();
  assert.equal(stats.count, 1269);
  assert.deepEqual(stats.byClass, { strong: 855, workable: 0, marginal: 414 });
  assert.equal(stats.totalCells, 3600);
  assert.equal(stats.feedLabel, 'SYNTHETIC');
  assert.equal(stats.confidence, 'Modeled');
  assert.equal(stats.unavailable, false);
  layer.disable(viewer);
  assert.equal(dataSource.show, false);
});

test('layer renders the unavailable state honestly: no cells, stats say so', async () => {
  const layer = createSovereignMeshCoverageLayer({
    source: {
      getSnapshot: async () =>
        normalizeSovereignMeshPayload({
          unavailable: true,
          reason: 'bridge not on this host',
          label: 'UNAVAILABLE',
          nodes: [],
          links: [],
        }),
    },
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  assert.equal(viewer.added[0].entities.values.length, 0);
  const stats = layer.getStats();
  assert.equal(stats.unavailable, true);
  assert.equal(stats.count, 0);
  assert.equal(stats.error, null);
});

test('layer keeps its last good coverage when a refresh fails', async () => {
  let fail = false;
  const layer = createSovereignMeshCoverageLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('Sovereign Mesh HTTP 502');
        return replaySnapshot();
      },
    },
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const before = viewer.added[0].entities.values.length;
  assert.ok(before > 0);
  fail = true;
  assert.equal(await layer.update(viewer), false);
  assert.equal(viewer.added[0].entities.values.length, before); // not emptied
  assert.match(layer.getStats().error, /Sovereign Mesh HTTP 502/);
});

test('layer requires a snapshot source', () => {
  assert.throws(() => createSovereignMeshCoverageLayer(), TypeError);
  assert.throws(() => createSovereignMeshCoverageLayer({ source: {} }), TypeError);
});
