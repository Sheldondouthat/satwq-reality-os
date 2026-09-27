import assert from 'node:assert/strict';
import test from 'node:test';
import { createMoonLayer } from './index.js';
import { moonPhase, moonIllumination, moonPosition } from './model.js';

test('illumination is ~0 at new moon (2026-02-17T12:00Z)', () => {
  const illum = moonIllumination(new Date('2026-02-17T12:00:00Z'));
  assert.ok(Math.abs(illum - 0) < 0.08, `illumination ${illum}`);
  assert.equal(moonPhase(new Date('2026-02-17T12:00:00Z')).name, 'New Moon');
});

test('illumination is ~1 at full moon (2026-03-03T11:00Z)', () => {
  const illum = moonIllumination(new Date('2026-03-03T11:00:00Z'));
  assert.ok(Math.abs(illum - 1) < 0.08, `illumination ${illum}`);
  assert.equal(moonPhase(new Date('2026-03-03T11:00:00Z')).name, 'Full Moon');
});

test('waxing/waning and named phases follow the lunation', () => {
  // A few days after the Feb 17 new moon: waxing crescent.
  const crescent = moonPhase(new Date('2026-02-21T12:00:00Z'));
  assert.equal(crescent.name, 'Waxing Crescent');
  assert.equal(crescent.waxing, true);
  // A few days after the Mar 3 full moon: waning gibbous.
  const gibbous = moonPhase(new Date('2026-03-07T12:00:00Z'));
  assert.equal(gibbous.name, 'Waning Gibbous');
  assert.equal(gibbous.waxing, false);
  // Quarter moons exist on both limbs.
  const firstQ = moonPhase(new Date('2026-02-24T12:00:00Z'));
  assert.equal(firstQ.name, 'First Quarter');
  const lastQ = moonPhase(new Date('2026-03-10T12:00:00Z'));
  assert.equal(lastQ.name, 'Last Quarter');
});

test('moonPosition returns a valid sub-lunar point', () => {
  const pos = moonPosition(new Date('2026-09-26T22:19:00Z'));
  assert.ok(pos.lat >= -28.6 && pos.lat <= 28.6, `lat ${pos.lat}`);
  assert.ok(pos.lon >= -180 && pos.lon <= 180, `lon ${pos.lon}`);
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
  const layer = createMoonLayer();
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources };
}

test('layer shape matches the catalog contract', () => {
  const h = harness();
  assert.equal(h.layer.id, 'moon');
  assert.equal(h.layer.name, 'Moon Phase');
  assert.equal(h.layer.icon, '🌙');
  assert.equal(h.layer.source, 'Computed (lunar ephemeris)');
  assert.equal(h.layer.updateInterval, 600000);
  h.layer.destroy(h.viewer);
});

test('layer plots the sub-lunar entity with a phase label', async () => {
  const h = harness();
  assert.equal(await h.layer.update(h.viewer), true);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, 'moon:position');
  const label = entities[0].label.text.getValue();
  assert.match(label, /^🌙 /);
  assert.match(label, /%$/);
  const stats = h.layer.getStats();
  assert.ok(typeof stats.phaseName === 'string' && stats.phaseName.length > 0);
  assert.ok(stats.illumination >= 0 && stats.illumination <= 1);
  assert.equal(typeof stats.waxing, 'boolean');
  assert.equal(stats.error, null);
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);
});
