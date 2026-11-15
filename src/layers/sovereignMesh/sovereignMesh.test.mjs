/**
 * Sovereign Mesh (nodes) layer tests (BM3). The falsifier (§7) is
 * exercised at the level this suite can reach: the replay payload —
 * the bridge's real coordinates — normalizes into descriptors at
 * exactly those coordinates, every description carries the §1
 * attribution verbatim, the label SYNTHETIC is never upgraded, the
 * layer is default-off, and the unavailable envelope renders as an
 * honest empty state rather than fabricated nodes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSovereignMeshLayer } from './index.js';
import { createSovereignMeshSource } from './source.js';
import {
  FADE_FLOOR,
  FADE_WINDOW_S,
  nodeOpacity,
  normalizeSovereignMeshPayload,
} from './records.js';
import {
  SOVEREIGN_MESH_NODES_ATTRIBUTION,
  marginStyle,
  nodeDescription,
} from './model.js';

// The bridge's replay product (feed_records.json, 2026-11-15):
// SYNTHETIC demo nodes at the operator's real anchor coordinates.
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
      altitude_m_reported: 640,
      battery_level: 64,
      voltage: 3.91,
      air_util_tx: 0.87,
      channel_utilization: 4.2,
      ground_elev_m_srtm: 601.3,
    },
  ],
  links: [
    {
      from_id: '!aa000001',
      to_id: '!aa000002',
      snr_db: 9.2,
      margin_class: 'strong',
      label: 'SYNTHETIC',
    },
    {
      from_id: '!aa000001',
      to_id: '!aa000003',
      snr_db: 3.1,
      margin_class: 'workable',
      label: 'SYNTHETIC',
    },
  ],
  ...overrides,
});

test('normalize carries the header verbatim and resolves nodes + links', () => {
  const snap = normalizeSovereignMeshPayload(replayPayload());
  assert.equal(snap.unavailable, false);
  assert.equal(snap.label, 'SYNTHETIC');
  assert.equal(snap.source, 'replay:sample_mqtt.jsonl');
  assert.equal(snap.confidence, 'Modeled');
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.links.length, 2);
  assert.equal(snap.droppedNodes, 0);
  const home = snap.nodes.find((n) => n.shortname === 'HOME');
  assert.equal(home.lat, 37.3186);
  assert.equal(home.lon, -80.6297);
});

test('normalize drops position-less nodes and links to nowhere, counted', () => {
  const snap = normalizeSovereignMeshPayload(
    replayPayload({
      nodes: [
        ...replayPayload().nodes,
        { id: '!bad', lat: 0, lon: 0 },
        { id: '!bad2', lat: 'x', lon: -80 },
      ],
      links: [
        { from_id: '!aa000001', to_id: '!ghost', margin_class: 'strong' },
      ],
    }),
  );
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.droppedNodes, 2);
  assert.equal(snap.links.length, 0);
  assert.equal(snap.droppedLinks, 1);
});

test('the unavailable envelope is a first-class snapshot, never null, never nodes', () => {
  const snap = normalizeSovereignMeshPayload({
    unavailable: true,
    reason: 'not readable',
    feed: 'Sovereign Mesh (nodes)',
    label: 'UNAVAILABLE',
    nodes: [],
    links: [],
  });
  assert.equal(snap.unavailable, true);
  assert.equal(snap.nodes.length, 0);
  assert.equal(normalizeSovereignMeshPayload({ nope: 1 }), null);
  assert.equal(normalizeSovereignMeshPayload(null), null);
});

test('nodeOpacity implements the FeedSpec fade: 900 s window, 0.35 floor', () => {
  assert.equal(FADE_WINDOW_S, 900);
  assert.equal(FADE_FLOOR, 0.35);
  assert.equal(nodeOpacity(0), 1);
  assert.equal(nodeOpacity(null), 1);
  assert.ok(Math.abs(nodeOpacity(450) - 0.675) < 1e-9);
  assert.equal(nodeOpacity(900), 0.35);
  assert.equal(nodeOpacity(86400), 0.35); // floor, never invisible
});

test('marginStyle covers the bridge classes plus an honest unknown', () => {
  assert.equal(marginStyle('strong').width, 3);
  assert.equal(marginStyle('workable').width, 2);
  assert.equal(marginStyle('marginal').width, 1.5);
  assert.equal(marginStyle('bogus'), marginStyle('unknown'));
});

test('nodeDescription states the label and carries the attribution verbatim', () => {
  const snap = normalizeSovereignMeshPayload(replayPayload());
  const html = nodeDescription(snap.nodes[0], snap);
  assert.ok(html.includes('SYNTHETIC'));
  assert.ok(html.includes('replay:sample_mqtt.jsonl'));
  assert.ok(html.includes(SOVEREIGN_MESH_NODES_ATTRIBUTION));
  assert.equal(
    SOVEREIGN_MESH_NODES_ATTRIBUTION,
    "Sovereign Mesh — the operator's own LoRa mesh network (Part 15, 902-928 MHz). Node positions and telemetry reported by the operator's own nodes; served locally, not redistributed.",
  );
});

test('source fetches the endpoint and passes the envelope through', async () => {
  const source = createSovereignMeshSource({
    fetchImpl: async (url) => {
      assert.equal(url, '/api/sovereign-mesh-nodes');
      return { ok: true, json: async () => replayPayload() };
    },
  });
  const snap = await source.getSnapshot();
  assert.equal(snap.nodes.length, 3);
  assert.equal(snap.label, 'SYNTHETIC');

  const down = createSovereignMeshSource({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ unavailable: true, nodes: [], links: [] }),
    }),
  });
  assert.equal((await down.getSnapshot()).unavailable, true);

  const broken = createSovereignMeshSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }),
  });
  await assert.rejects(() => broken.getSnapshot(), /Malformed Sovereign Mesh/);
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

test('FALSIFIER: nodes render at the bridge coordinates, labeled SYNTHETIC, default off', async () => {
  const layer = createSovereignMeshLayer({
    source: {
      getSnapshot: async () =>
        normalizeSovereignMeshPayload(replayPayload()),
    },
  });
  assert.equal(layer.id, 'sovereign-mesh-nodes');
  const viewer = fakeViewer();
  layer.init(viewer);
  const dataSource = viewer.added[0];
  assert.equal(dataSource.show, false); // enabledByDefault: false
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);

  const now = Cesium.JulianDate.now();
  const nodeEntities = dataSource.entities.values.filter((e) =>
    e.id.startsWith('sovereign-mesh-node-'),
  );
  assert.equal(nodeEntities.length, 3);
  const positions = new Map();
  for (const e of nodeEntities) {
    const carto = Cesium.Cartographic.fromCartesian(
      e.position.getValue(now),
    );
    positions.set(e.properties.shortname.getValue(now), {
      lat: Cesium.Math.toDegrees(carto.latitude),
      lon: Cesium.Math.toDegrees(carto.longitude),
      label: e.properties.feedLabel.getValue(now),
      desc: e.description.getValue(now),
    });
  }
  const expected = {
    HOME: [37.3186, -80.6297],
    RDGN: [37.37, -80.6209],
    MOBL: [37.3296, -80.6923],
  };
  for (const [short, [lat, lon]] of Object.entries(expected)) {
    const got = positions.get(short);
    assert.ok(got, `node ${short} rendered`);
    assert.ok(Math.abs(got.lat - lat) < 1e-6, `${short} lat`);
    assert.ok(Math.abs(got.lon - lon) < 1e-6, `${short} lon`);
    assert.equal(got.label, 'SYNTHETIC'); // never upgraded to LIVE
    assert.ok(got.desc.includes(SOVEREIGN_MESH_NODES_ATTRIBUTION));
  }
  const linkEntities = dataSource.entities.values.filter((e) =>
    e.id.startsWith('sovereign-mesh-link-'),
  );
  assert.equal(linkEntities.length, 2);
  assert.ok(linkEntities.every((e) => e.polyline));
  const stats = layer.getStats();
  assert.equal(stats.count, 3);
  assert.equal(stats.links, 2);
  assert.equal(stats.feedLabel, 'SYNTHETIC');
  assert.equal(stats.unavailable, false);
  layer.disable(viewer);
  assert.equal(dataSource.show, false);
});

test('layer renders the unavailable state honestly: no entities, stats say so', async () => {
  const layer = createSovereignMeshLayer({
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
  const dataSource = viewer.added[0];
  assert.equal(dataSource.entities.values.length, 0);
  const stats = layer.getStats();
  assert.equal(stats.unavailable, true);
  assert.equal(stats.count, 0);
  assert.equal(stats.error, null);
});

test('layer keeps its last good mesh when a refresh fails', async () => {
  let fail = false;
  const layer = createSovereignMeshLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('Sovereign Mesh HTTP 502');
        return normalizeSovereignMeshPayload(replayPayload());
      },
    },
  });
  const viewer = fakeViewer();
  layer.init(viewer);
  layer.enable(viewer);
  assert.equal(await layer.update(viewer), true);
  const dataSource = viewer.added[0];
  const before = dataSource.entities.values.length;
  assert.ok(before > 0);
  fail = true;
  assert.equal(await layer.update(viewer), false);
  assert.equal(dataSource.entities.values.length, before); // not emptied
  assert.match(layer.getStats().error, /Sovereign Mesh HTTP 502/);
});
