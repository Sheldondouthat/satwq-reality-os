import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createFireSpreadLayer,
  createForecastConesLayer,
  createVolcanicAshLayer,
} from './index.js';

const mockViewer = () => {
  const added = [];
  return {
    added,
    dataSources: {
      add(ds) {
        added.push(ds);
      },
      remove(ds) {
        const i = added.indexOf(ds);
        if (i >= 0) added.splice(i, 1);
      },
    },
  };
};

const IGNITIONS = [
  { lat: 40.0, lon: -121.0, label: 'Smoke centroid A', source: 'HMS smoke (fixture)' },
  { lat: 41.5, lon: -120.2, label: 'Perimeter anchor B', source: 'WFIGS (fixture)' },
];
const WIND = { fromDeg: 270, speedKmh: 20, label: 'fixture wind', measured: true };

test('fire-spread layer: lifecycle + rings + step toggle', async () => {
  const layer = createFireSpreadLayer({ ignitions: IGNITIONS, wind: WIND });
  assert.equal(layer.id, 'fire-spread');
  const viewer = mockViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  const stats = layer.getStats();
  assert.equal(stats.ignitions, 2);
  assert.equal(stats.count, 2 * 3, '2 ignitions x 3 hours');
  assert.ok(stats.activeHour === 6, 'defaults to the first (nearest) hour');
  assert.ok(stats.wind.label.includes('fixture wind'));
  const controls = layer.getRowControls();
  assert.ok(controls.chips.length === 3, 'one chip per time step');
  assert.ok(controls.info.includes('MODELED'), 'modeled label is surfaced');

  layer.setParams({ hour: 12 });
  assert.equal(layer.getStats().activeHour, 12);
  const rows = viewer.added[0].entities.values;
  const active = rows.filter((e) => e.id === 'fire-spread:0:12');
  assert.equal(active.length, 1, 'selected step rendered');
  layer.disable();
  layer.destroy(viewer);
  assert.equal(viewer.added.length, 0, 'data source removed');
});

test('fire-spread layer: windProvider override wins over static wind', async () => {
  const layer = createFireSpreadLayer({
    ignitions: IGNITIONS,
    windProvider: async () => ({ fromDeg: 0, speedKmh: 30, label: 'measured wind', measured: true }),
  });
  const viewer = mockViewer();
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().wind.measured, true);
  assert.ok(layer.getStats().wind.label.includes('measured wind'));
  layer.destroy(viewer);
});

test('forecast-cones layer: renders one labeled entity per storm, empty-state honest', async () => {
  const ring = [[-60, 20], [-55, 25], [-50, 22], [-55, 18], [-60, 20]];
  const makeSource = (storms, unavailable = false) => ({
    async getSnapshot() {
      return { storms, unavailable, reason: unavailable ? 'upstream down' : null };
    },
  });
  const storm = {
    id: 'al142026',
    name: 'Test Storm',
    classification: 'HU',
    position: { longitude: -57, latitude: 21 },
    advisoryNumber: '12',
    cone: { type: 'Polygon', coordinates: [ring] },
  };

  const layer = createForecastConesLayer({ source: makeSource([storm]) });
  const viewer = mockViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  const entities = viewer.added[0].entities.values;
  assert.equal(entities.length, 1, 'one entity per storm');
  assert.ok(entities[0].label.text.getValue().includes('Test Storm'));
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().empty, false);
  layer.destroy(viewer);

  const empty = createForecastConesLayer({ source: makeSource([]) });
  const viewer2 = mockViewer();
  empty.init(viewer2);
  empty.enable();
  assert.equal(await empty.update(), true);
  assert.equal(viewer2.added[0].entities.values.length, 0);
  assert.equal(empty.getStats().empty, true);
  assert.ok(empty.getRowControls().info.includes('No active'), 'empty-state surfaced');
  empty.destroy(viewer2);
});

test('volcanic-ash layer: renders advisory clouds, degrades when feed is down', async () => {
  const advisory = {
    volcano: 'SAKURAJIMA (AIRA CALDERA)',
    volcanoId: '282080',
    country: 'JAPAN',
    advisoryNumber: '2026/136',
    dtgMs: Date.UTC(2026, 7, 2, 15, 31),
    summit: { lat: 31.6, lon: 130.65 },
    clouds: [
      { kind: 'observed', tauHours: 0, levels: 'SFC/FL140', polygon: [[130.7, 31.6], [130.6, 31.5], [130.5, 31.6], [130.7, 31.6]] },
    ],
  };
  const okSource = { async getSnapshot() { return { advisories: [advisory], fetchedAt: Date.now(), source: 'Tokyo VAAC', coverage: '', unavailable: false, reason: null }; } };
  const layer = createVolcanicAshLayer({ source: okSource });
  const viewer = mockViewer();
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  const entities = viewer.added[0].entities.values;
  assert.equal(entities.length, 2, '1 cloud polygon + 1 label');
  assert.ok(entities[1].label.text.getValue().includes('SAKURAJIMA'));
  const controls = layer.getRowControls();
  assert.equal(controls.list.items.length, 1);
  layer.destroy(viewer);

  const downSource = { async getSnapshot() { return { advisories: [], fetchedAt: Date.now(), source: 'Tokyo VAAC', coverage: '', unavailable: true, reason: 'VAAC HTTP 502' }; } };
  const down = createVolcanicAshLayer({ source: downSource });
  const viewer2 = mockViewer();
  down.init(viewer2);
  down.enable();
  assert.equal(await down.update(), true);
  assert.equal(viewer2.added[0].entities.values.length, 0, 'nothing rendered when feed is down');
  assert.ok(down.getStats().unavailable, true);
  assert.ok(down.getRowControls().info.includes('unavailable'), 'degraded state surfaced');
  down.destroy(viewer2);
});
