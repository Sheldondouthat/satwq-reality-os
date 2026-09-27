import assert from 'node:assert/strict';
import test from 'node:test';
import { createAuroraLayer } from './index.js';
import { createAuroraSource } from './source.js';
import { normalizeAuroraSnapshot } from './records.js';
import {
  MAGNETIC_NORTH_POLE,
  kpColor,
  kpToGScale,
  ovalBoundaryMagLat,
  ovalRingPositions,
} from './model.js';

const feed = () => [
  { time_tag: '2026-09-26T22:30:00Z', estimated_kp: 1.0 },
  { time_tag: '2026-09-26T23:00:00Z', estimated_kp: 6.33 },
];

test('normalizeAuroraSnapshot takes the latest valid reading', () => {
  const row = normalizeAuroraSnapshot(feed());
  assert.equal(row.kp, 6.33);
  assert.equal(row.timeMs, Date.parse('2026-09-26T23:00:00Z'));
});

test('normalizeAuroraSnapshot skips bad tail entries, rejects garbage', () => {
  const row = normalizeAuroraSnapshot([
    { time_tag: '2026-09-26T22:30:00Z', estimated_kp: 2.0 },
    { time_tag: 'broken', estimated_kp: 99 },
    { time_tag: '2026-09-26T23:00:00Z', estimated_kp: 'x' },
  ]);
  assert.equal(row.kp, 2.0);
  assert.equal(normalizeAuroraSnapshot([]), null);
  assert.equal(normalizeAuroraSnapshot(null), null);
  assert.equal(normalizeAuroraSnapshot([{ time_tag: 'x' }]), null);
});

test('Kp color scale and G-scale descriptions', () => {
  assert.equal(kpToGScale(1.0), 'G0 · Quiet');
  assert.equal(kpToGScale(5.0), 'G1 · Minor');
  assert.equal(kpToGScale(9.0), 'G5 · Extreme');
  assert.notDeepEqual(
    kpColor(1.0).toCssColorString(),
    kpColor(8.0).toCssColorString(),
  );
});

test('oval boundary expands as Kp rises, ring stays on the globe', () => {
  assert.ok(ovalBoundaryMagLat(1) > ovalBoundaryMagLat(8));
  assert.ok(ovalBoundaryMagLat(0) <= 67 && ovalBoundaryMagLat(9) >= 50);
  for (const kp of [1, 5, 8]) {
    const ring = ovalRingPositions(kp, 36);
    assert.equal(ring.length, 36);
    const minLat = MAGNETIC_NORTH_POLE.lat - (90 - ovalBoundaryMagLat(kp)) - 1;
    for (const [lon, lat] of ring) {
      assert.ok(lon >= -180 && lon <= 180, `lon ${lon}`);
      assert.ok(lat >= minLat && lat <= 90, `lat ${lat} (kp ${kp})`);
    }
    // Every ring point sits at the oval's angular radius from the pole.
    const poleLat = (MAGNETIC_NORTH_POLE.lat * Math.PI) / 180;
    const poleLon = (MAGNETIC_NORTH_POLE.lon * Math.PI) / 180;
    const expected = 90 - ovalBoundaryMagLat(kp);
    for (const [lon, lat] of ring) {
      const la = (lat * Math.PI) / 180;
      const lo = (lon * Math.PI) / 180;
      const dist =
        (Math.acos(
          Math.min(
            1,
            Math.sin(poleLat) * Math.sin(la) +
              Math.cos(poleLat) * Math.cos(la) * Math.cos(lo - poleLon),
          ),
        ) *
          180) /
        Math.PI;
      assert.ok(Math.abs(dist - expected) < 0.5, `dist ${dist} (kp ${kp})`);
    }
  }
});

test('source throws on HTTP errors and malformed feeds', async () => {
  const bad = createAuroraSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(bad.getSnapshot(), /503/);
  const malformed = createAuroraSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
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
  const layer = createAuroraLayer({
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

test('layer draws the oval and fails soft', async () => {
  const h = harness({ getSnapshot: async () => ({ kp: 6.33, timeMs: 1 }) });
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.layer.getStats().kp, 6.33);
  assert.equal(h.events.length, 1);
  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].gScale, 'G2 · Moderate');
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);

  const failing = harness({
    getSnapshot: async () => {
      throw new Error('down');
    },
  });
  assert.equal(await failing.layer.update(failing.viewer), false);
  assert.match(failing.layer.getStats().error, /down/);
});
