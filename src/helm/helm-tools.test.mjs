/**
 * Helm v0 tool-executor tests: live-shaped fixtures through injected
 * fetch; citation presence asserted on every world-claim; trend math,
 * STALE grammar, scene serialization, and the orbit tools exercised
 * against the repo's own satellite.js and a real ISS TLE.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as satellite from 'satellite.js';
import { createHelmTools, GLEN_LYN } from '../../public/helm-tools.js';

const ISS_TLE = [
  'ISS (ZARYA)',
  '1 25544U 98067A   26318.94812295  .00009771  00000+0  18276-3 0  9990',
  '2 25544  51.6323 274.0377 0007412  26.4902 333.6464 15.49382049595125',
].join('\n');
// TLE epoch 2026 day 318.948 ≈ 2026-11-14T22:45Z. Test "now": 1 h later.
const NOW = Date.parse('2026-11-14T23:45:00Z');

function riverPayload(overrides = {}) {
  return {
    id: 'usgs-water-glen-lyn',
    generatedAt: '2026-11-14T23:45:10Z',
    stale: false,
    site: '03176500',
    dataTime: '2026-11-14T23:30:00.000Z',
    ageSeconds: 900,
    maxAgeSeconds: 3600,
    gageHeightFt: 2.95,
    dischargeCfs: 1410,
    approvalStatus: 'Provisional',
    ...overrides,
  };
}

function wdfnSeries(values) {
  return {
    type: 'FeatureCollection',
    features: values.map(([time, value], i) => ({
      type: 'Feature',
      id: `f${i}`,
      properties: {
        time,
        value: String(value),
        parameter_code: '00065',
        statistic_id: '00011',
        approval_status: 'Provisional',
        monitoring_location_id: 'USGS-03176500',
      },
      geometry: { type: 'Point', coordinates: [GLEN_LYN.lon, GLEN_LYN.lat] },
    })),
  };
}

function mockFetch(routes) {
  return async (url) => {
    const u = String(url);
    for (const [needle, body] of Object.entries(routes)) {
      if (u.includes(needle)) {
        return {
          ok: true,
          status: 200,
          json: async () => body,
          text: async () =>
            typeof body === 'string' ? body : JSON.stringify(body),
        };
      }
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => '',
    };
  };
}

function helmWith(routes, now = NOW) {
  return createHelmTools({
    fetchImpl: mockFetch(routes),
    loadSatellite: async () => satellite,
    now: () => now,
  });
}

describe('helm tools — navigation & state (no fetch)', () => {
  it('fly_to_location preset resolves the gauge with a citation', async () => {
    const { tools } = helmWith({});
    const r = await tools.fly_to_location({ place: 'river gauge' });
    assert.equal(r.ok, true);
    assert.equal(r.view.lat, GLEN_LYN.lat);
    assert.equal(r.citations.length, 1);
    assert.equal(r.citations[0].confidence, 'MEASURED');
  });
  it('zoom/move/layers/hud/view-state/scene_save compose one world state', async () => {
    const { tools, state } = helmWith({});
    await tools.zoom_to_globe();
    assert.equal(state.view.rangeM, 22_000_000);
    await tools.move_camera({ direction: 'north' });
    assert.ok(state.view.lat > 37.303672);
    const layer = await tools.set_layer_visibility({
      layer: 'wspr',
      visible: true,
    });
    assert.equal(layer.ok, true);
    const bad = await tools.set_layer_visibility({
      layer: 'nope',
      visible: true,
    });
    assert.equal(bad.ok, false);
    assert.match(bad.summary, /UNKNOWN/);
    await tools.set_hud({ layout: 'minimal' });
    const view = await tools.get_current_view_state();
    assert.match(view.summary, /wspr/);
    const scene = await tools.scene_save({ name: 'first helm' });
    assert.equal(scene.ok, true);
    assert.equal(scene.scene.name, 'first helm');
    assert.equal(scene.scene.layers.wspr, true);
    assert.ok(scene.scene.conversationTurn >= 1);
  });
  it('panel_summon opens held panels and refuses the mesh panel by name (BM3)', async () => {
    const { tools } = helmWith({});
    assert.equal((await tools.panel_summon({ panel: 'river' })).ok, true);
    const mesh = await tools.panel_summon({ panel: 'mesh' });
    assert.equal(mesh.ok, false);
    assert.equal(mesh.blocked, 'BM3');
  });
});

describe('helm tools — world_ask river-trend (exchange 1)', () => {
  const routes = {
    '/api/usgs-water-glen-lyn': riverPayload(),
    'collections/continuous': wdfnSeries([
      ['2026-11-14T21:30:00+00:00', 2.88],
      ['2026-11-14T22:30:00+00:00', 2.91],
      ['2026-11-14T23:30:00+00:00', 2.95],
    ]),
  };
  it('answers Rising with two citations carrying the data timestamps', async () => {
    const { tools } = helmWith(routes);
    const r = await tools.world_ask({ template: 'river-trend' });
    assert.equal(r.ok, true);
    assert.match(
      r.summary,
      /Rising: 2\.88 ft at 2026-11-14T21:30.*2\.95 ft at 2026-11-14T23:30/,
    );
    assert.match(r.summary, /2\.95 ft, 1410 ft³\/s/);
    assert.match(r.summary, /MEASURED \(Provisional\)/);
    assert.match(r.summary, /20% of it/);
    assert.equal(r.citations.length, 2);
    assert.equal(r.citations[0].dataTimestamp, '2026-11-14T23:30:00.000Z');
    assert.equal(r.citations[0].confidence, 'MEASURED');
    assert.equal(r.citations[1].dataTimestamp, '2026-11-14T23:30:00+00:00');
  });
  it('a reading past max-age carries STALE in the sentence', async () => {
    const staleRoutes = {
      ...routes,
      '/api/usgs-water-glen-lyn': riverPayload({
        ageSeconds: 7200,
        stale: true,
      }),
    };
    const { tools } = helmWith(staleRoutes);
    const r = await tools.world_ask({ template: 'river-trend' });
    assert.match(r.summary, /STALE — this reading is 120 min old/);
  });
  it('a dead endpoint is an error, never an invented value', async () => {
    const { tools } = helmWith({});
    await assert.rejects(
      () => tools.world_ask({ template: 'river-trend' }),
      /fetch_404/,
    );
  });
  it('an unheld template refuses honestly', async () => {
    const { tools } = helmWith({});
    const r = await tools.world_ask({ template: 'stock-prices' });
    assert.equal(r.ok, false);
    assert.match(r.summary, /UNKNOWN/);
  });
});

describe('helm tools — orbit tools (exchange 5 substrate + passes)', () => {
  const routes = {
    '/api/celestrak/stations': ISS_TLE,
    '/api/aircraft': {
      generatedAt: '2026-11-14T23:45:00Z',
      count: 2,
      servedBy: ['adsb_lol'],
      degraded: false,
      aircraft: [],
    },
  };
  it('next_satellite_pass computes a real pass from the TLE, MODELED + epoch cited', async () => {
    const { tools } = helmWith(routes);
    const r = await tools.next_satellite_pass({ target: 'ISS (ZARYA)' });
    assert.equal(r.ok, true, r.summary);
    assert.ok(Date.parse(r.pass.aos) < Date.parse(r.pass.los));
    assert.ok(r.pass.maxElevationDeg > 10);
    assert.equal(r.citations[0].confidence, 'MODELED');
    assert.match(r.citations[0].dataTimestamp, /^2026-11-14T22:/);
  });
  it('identify-light answers with a named contact or UNKNOWN + what was checked', async () => {
    const { tools } = helmWith(routes);
    const r = await tools.world_ask({ template: 'identify-light' });
    assert.equal(r.ok, true);
    assert.match(r.summary, /ISS \(ZARYA\)|UNKNOWN/);
    assert.match(r.summary, /Checked: 1 station-catalog satellites/);
    assert.ok(r.citations.length >= 2);
    assert.ok(
      r.citations.every((c) => c.feed && c.dataTimestamp && c.confidence),
    );
  });
  it('a missing satellite library refuses instead of estimating', async () => {
    const tools = createHelmTools({
      fetchImpl: mockFetch(routes),
      loadSatellite: async () => {
        throw new Error('cdn_down');
      },
      now: () => NOW,
    });
    const r = await tools.tools.next_satellite_pass({ target: 'ISS (ZARYA)' });
    assert.equal(r.ok, false);
    assert.match(r.summary, /UNKNOWN/);
  });
});
