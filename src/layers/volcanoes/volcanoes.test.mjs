import assert from 'node:assert/strict';
import test from 'node:test';
import { createVolcanoesLayer } from './index.js';
import { createVolcanoSource } from './source.js';
import { normalizeVolcanoSnapshot } from './records.js';
import {
  colorCodeColor,
  isElevated,
  selectVolcanoOverlayCohort,
} from './model.js';

const feature = (overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-155.6, 19.4] },
  properties: {
    volcanoName: 'Kilauea',
    vnum: '332010',
    alertLevel: 'WATCH',
    colorCode: 'ORANGE',
    ...overrides,
  },
});
const payload = (features) => ({ type: 'FeatureCollection', features });

test('normalizeVolcanoSnapshot accepts a valid USGS payload', () => {
  const rows = normalizeVolcanoSnapshot(
    payload([feature(), feature({ vnum: '332011', volcanoName: 'Mauna Loa' })]),
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].stableId, '332010');
  assert.equal(rows[0].name, 'Kilauea');
  assert.equal(rows[0].colorCode, 'ORANGE');
});

test('normalizeVolcanoSnapshot rejects malformed payloads', () => {
  assert.equal(normalizeVolcanoSnapshot(null), null);
  assert.equal(normalizeVolcanoSnapshot({ features: 'nope' }), null);
  assert.equal(
    normalizeVolcanoSnapshot(payload([{ type: 'Feature' }])),
    null,
  );
  const noGeometry = payload([{ type: 'Feature', properties: { vnum: '2' } }]);
  assert.equal(normalizeVolcanoSnapshot(noGeometry), null);
  const badCoords = payload([
    {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [999, 19.4] },
      properties: { vnum: '1' },
    },
  ]);
  assert.equal(normalizeVolcanoSnapshot(badCoords), null);
  const dupes = payload([feature(), feature()]);
  assert.equal(normalizeVolcanoSnapshot(dupes), null);
});

test('color codes map to distinct alert colors; elevated is RED/ORANGE/YELLOW', () => {
  assert.ok(isElevated('RED'));
  assert.ok(isElevated('orange'));
  assert.ok(isElevated('YELLOW'));
  assert.ok(!isElevated('GREEN'));
  assert.ok(!isElevated('UNASSIGNED'));
  assert.notDeepEqual(
    colorCodeColor('RED').toCssColorString(),
    colorCodeColor('GREEN').toCssColorString(),
  );
});

test('elevated volcanoes win the overlay cohort', () => {
  const mk = (id, colorCode) => ({
    id,
    position: null,
    variant: 'label',
    title: id,
    subtitle: '',
    accent: '',
    colorCode,
  });
  const cohort = selectVolcanoOverlayCohort(
    [mk('a', 'GREEN'), mk('b', 'RED'), mk('c', 'UNASSIGNED')],
    2,
  );
  assert.deepEqual(
    cohort.map((e) => e.id),
    ['b', 'a'],
  );
});

test('source throws on HTTP errors and malformed bodies, honors abort', async () => {
  const bad = createVolcanoSource({
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  await assert.rejects(bad.getSnapshot(), /HTTP 500/);
  const malformed = createVolcanoSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
  const abort = new AbortController();
  abort.abort();
  const source = createVolcanoSource({
    fetchImpl: async () => ({ ok: true, json: async () => payload([]) }),
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

function harness(source) {
  const sources = [];
  const events = [];
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
  const layer = createVolcanoesLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events };
}

test('layer publishes entities, survives upstream failure, cleans up on disable', async () => {
  const rows = normalizeVolcanoSnapshot(payload([feature()]));
  const h = harness({ getSnapshot: async () => rows });
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.events.length, 1);

  const failing = harness({
    getSnapshot: async () => {
      throw new Error('boom');
    },
  });
  assert.equal(await failing.layer.update(failing.viewer), false);
  assert.match(failing.layer.getStats().error, /boom/);
  assert.equal(failing.events.length, 0);

  h.layer.disable(h.viewer);
  assert.equal(await h.layer.update(h.viewer), false);
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);
});
