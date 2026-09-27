import assert from 'node:assert/strict';
import test from 'node:test';
import { createMeteorsLayer } from './index.js';
import { createMeteorSource } from './source.js';
import {
  METEOR_SHOWERS,
  showersActiveOn,
  dayOfYear,
} from './records.js';
import {
  gmstDeg,
  radiantSubpoint,
  meteorColor,
} from './model.js';

const d = (iso) => new Date(iso);

test('shower table is sane', () => {
  assert.ok(METEOR_SHOWERS.length >= 8);
  for (const s of METEOR_SHOWERS) {
    assert.ok(s.peakMonth >= 1 && s.peakMonth <= 12);
    assert.ok(s.ra >= 0 && s.ra < 24);
    assert.ok(s.dec >= -90 && s.dec <= 90);
    assert.ok(s.zhr > 0);
  }
});

test('active windows contain their peaks and wrap the year', () => {
  const names = (iso) => showersActiveOn(d(iso)).map((s) => s.name);
  assert.ok(names('2026-08-12T12:00:00Z').includes('Perseids'));
  assert.ok(names('2026-12-13T12:00:00Z').includes('Geminids'));
  assert.ok(names('2026-01-03T12:00:00Z').includes('Quadrantids'));
  assert.ok(names('2026-12-30T12:00:00Z').includes('Quadrantids'));
  assert.ok(!names('2026-06-15T12:00:00Z').includes('Geminids'));
  assert.ok(!names('2026-08-12T12:00:00Z').includes('Geminids'));
});

test('dayOfYear handles leap years', () => {
  assert.equal(dayOfYear(d('2024-03-01T00:00:00Z')), 61);
  assert.equal(dayOfYear(d('2025-03-01T00:00:00Z')), 60);
});

test('radiant subpoint: latitude equals declination, longitude shifts with time', () => {
  const t0 = d('2026-08-12T00:00:00Z');
  const t6 = d('2026-08-12T06:00:00Z');
  const p0 = radiantSubpoint(3.1, 58.0, t0);
  const p6 = radiantSubpoint(3.1, 58.0, t6);
  assert.equal(p0.lat, 58.0);
  assert.ok(p0.lon >= -180 && p0.lon <= 180);
  // Earth rotates ~90° in 6h; the subpoint moves west.
  const delta = ((p0.lon - p6.lon + 540) % 360) - 180;
  assert.ok(Math.abs(delta - 90) < 2, `delta=${delta}`);
});

test('gmst is a valid angle', () => {
  const g = gmstDeg(d('2026-08-12T00:00:00Z'));
  assert.ok(g >= 0 && g < 360);
});

test('meteor colors distinguish strong showers', () => {
  assert.notDeepEqual(
    meteorColor(150).toCssColorString(),
    meteorColor(10).toCssColorString(),
  );
});

test('source snapshot is keyed by date', async () => {
  const source = createMeteorSource({ now: () => d('2026-08-12T12:00:00Z') });
  const rows = await source.getSnapshot();
  assert.ok(rows.some((r) => r.shower.name === 'Perseids'));
  assert.ok(rows.every((r) => typeof r.stableId === 'string'));
  const quiet = createMeteorSource({ now: () => d('2026-06-15T12:00:00Z') });
  assert.equal((await quiet.getSnapshot()).length, 0);
});

function harness(source, now) {
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
  const layer = createMeteorsLayer({
    source,
    overlayHost: {
      setEntries(...args) {
        events.push(args);
      },
      setVisible() {},
      clearSource() {},
    },
    now,
  });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources, events };
}

test('layer renders active showers and clears them when quiet', async () => {
  const activeDate = () => d('2026-12-13T12:00:00Z');
  const h = harness(createMeteorSource({ now: activeDate }), activeDate);
  assert.equal(await h.layer.update(h.viewer), true);
  assert.ok(h.layer.getStats().count >= 1);
  assert.equal(h.events.length, 1);
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);

  const quietDate = () => d('2026-06-15T12:00:00Z');
  const q = harness(createMeteorSource({ now: quietDate }), quietDate);
  assert.equal(await q.layer.update(q.viewer), true);
  assert.equal(q.layer.getStats().count, 0);
  q.layer.destroy(q.viewer);
});
