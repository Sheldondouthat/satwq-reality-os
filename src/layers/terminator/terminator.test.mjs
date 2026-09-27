import assert from 'node:assert/strict';
import test from 'node:test';
import { createTerminatorLayer } from './index.js';
import { createTerminatorSource } from './source.js';
import {
  subsolarPoint,
  antisolarPoint,
  terminatorRing,
  nightCapRing,
  angularDistance,
} from './model.js';

test('subsolarPoint latitude is ~0 at the March equinox', () => {
  const sub = subsolarPoint(new Date('2026-03-20T03:00:00Z'));
  assert.ok(Math.abs(sub.lat) < 1.5, `lat ${sub.lat}`);
  assert.ok(sub.lon >= -180 && sub.lon <= 180, `lon ${sub.lon}`);
});

test('subsolarPoint follows the seasons', () => {
  const june = subsolarPoint(new Date('2026-06-21T12:00:00Z'));
  const december = subsolarPoint(new Date('2026-12-21T12:00:00Z'));
  assert.ok(june.lat > 20, `june lat ${june.lat}`);
  assert.ok(december.lat < -20, `december lat ${december.lat}`);
});

test('terminator ring points are all ~90° from the subsolar point', () => {
  const date = new Date('2026-09-26T22:19:00Z');
  const sub = subsolarPoint(date);
  const ring = terminatorRing(date, 72);
  assert.equal(ring.length, 72);
  for (const [lon, lat] of ring) {
    assert.ok(lon >= -180 && lon <= 180, `lon ${lon}`);
    assert.ok(lat >= -90 && lat <= 90, `lat ${lat}`);
    const dist = angularDistance([sub.lon, sub.lat], [lon, lat]);
    assert.ok(Math.abs(dist - 90) < 0.5, `dist ${dist}`);
  }
});

test('night cap ring is 90° around the antisolar point', () => {
  const date = new Date('2026-09-26T22:19:00Z');
  const anti = antisolarPoint(date);
  const sub = subsolarPoint(date);
  assert.ok(Math.abs(anti.lat + sub.lat) < 0.01);
  const ring = nightCapRing(date, 36);
  for (const [lon, lat] of ring) {
    const dist = angularDistance([anti.lon, anti.lat], [lon, lat]);
    assert.ok(Math.abs(dist - 90) < 0.5, `dist ${dist}`);
  }
});

test('terminator source returns the current instant', async () => {
  const source = createTerminatorSource();
  const before = Date.now();
  const { timeMs } = await source.getSnapshot();
  assert.ok(timeMs >= before && timeMs <= Date.now());
});

function harness() {
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
  const layer = createTerminatorLayer({ source: createTerminatorSource() });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources };
}

test('layer shape matches the catalog contract', () => {
  const h = harness();
  assert.equal(h.layer.id, 'terminator');
  assert.equal(h.layer.name, 'Day/Night Terminator');
  assert.equal(h.layer.icon, '🌗');
  assert.equal(h.layer.source, 'Computed (solar ephemeris)');
  assert.equal(h.layer.updateInterval, 60000);
  h.layer.destroy(h.viewer);
});

test('layer draws the terminator ring and night cap, then recomputes', async () => {
  const h = harness();
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 2);
  const ids = entities.map((e) => e.id).sort();
  assert.deepEqual(ids, ['terminator:night', 'terminator:ring']);
  const stats = h.layer.getStats();
  assert.ok(Math.abs(stats.subsolarLat) < 90);
  assert.ok(stats.subsolarLon >= -180 && stats.subsolarLon <= 180);
  assert.equal(stats.error, null);
  // Recompute on update: entity count stays stable.
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.sources[0].entities.values.length, 2);
  h.layer.disable(h.viewer);
  assert.equal(h.sources[0].show, false);
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);
});
