import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createSpaceWeatherLayer } from './index.js';
import { createSpaceWeatherSource } from './source.js';
import { normalizeSpaceWeatherSnapshot } from './records.js';
import { solarWindColor, solarWindLabel } from './model.js';

const swepamFeed = () => [
  {
    time_tag: '2026-09-26T20:00:00',
    dsflag: 0,
    dens: 6.2,
    speed: 402.1,
    temperature: 98340,
  },
  {
    time_tag: '2026-09-26T21:00:00',
    dsflag: 0,
    dens: 5.8,
    speed: 441.7,
    temperature: 112050,
  },
  // Bad tail row: values nulled when the instrument drops out.
  { time_tag: '2026-09-26T22:00:00', dsflag: 1, dens: null, speed: null, temperature: null },
];

const magFeed = () => [
  { time_tag: '2026-09-26T20:00:00', dsflag: 0, gsm_bz: 1.4 },
  { time_tag: '2026-09-26T21:00:00', dsflag: 0, gsm_bz: -3.2 },
  { time_tag: '2026-09-26T22:00:00', dsflag: 1, gsm_bz: null },
];

test('normalizeSpaceWeatherSnapshot takes the latest fully-valid merged row', () => {
  const row = normalizeSpaceWeatherSnapshot(swepamFeed(), magFeed());
  assert.equal(row.speedKms, 441.7);
  assert.equal(row.densityPerCm3, 5.8);
  assert.equal(row.tempK, 112050);
  assert.equal(row.bzGsm, -3.2);
  assert.equal(row.timeMs, Date.parse('2026-09-26T21:00:00Z'));
});

test('normalizeSpaceWeatherSnapshot rejects garbage', () => {
  assert.equal(normalizeSpaceWeatherSnapshot([], magFeed()), null);
  assert.equal(normalizeSpaceWeatherSnapshot(null, magFeed()), null);
  assert.equal(
    normalizeSpaceWeatherSnapshot([{ time_tag: 'x', dens: 1, speed: 2, temperature: 3 }], magFeed()),
    null,
  );
  // Swepam valid but no matching mag row with finite gsm_bz.
  assert.equal(
    normalizeSpaceWeatherSnapshot(
      [{ time_tag: '2026-09-26T23:00:00', dens: 1, speed: 2, temperature: 3 }],
      magFeed(),
    ),
    null,
  );
  assert.equal(
    normalizeSpaceWeatherSnapshot(
      [{ time_tag: '2026-09-26T21:00:00', dens: 1, speed: 2, temperature: 3 }],
      [{ time_tag: '2026-09-26T21:00:00', gsm_bz: 'bad' }],
    ),
    null,
  );
});

test('solarWindColor ramps green to red with speed', () => {
  const slow = solarWindColor(320);
  const fast = solarWindColor(850);
  assert.notDeepEqual(slow.toCssColorString(), fast.toCssColorString());
  assert.ok(slow.green > slow.red, 'slow wind should be greenish');
  assert.ok(fast.red > fast.green, 'fast wind should be reddish');
});

test('solarWindLabel formats the subsolar readout', () => {
  assert.equal(
    solarWindLabel({ speedKms: 452.4, bzGsm: -3.17 }),
    'SOLAR WIND 452 km/s · Bz -3.2 nT',
  );
});

test('source fetches both SWPC endpoints and throws on failure', async () => {
  const calls = [];
  const good = createSpaceWeatherSource({
    fetchImpl: async (url) => {
      calls.push(url);
      const payload = url.includes('/mag/') ? magFeed() : swepamFeed();
      return { ok: true, json: async () => payload };
    },
  });
  const row = await good.getSnapshot();
  assert.equal(calls.length, 2);
  assert.ok(calls.some((u) => u.includes('swepam')));
  assert.ok(calls.some((u) => u.includes('mag')));
  assert.equal(row.speedKms, 441.7);
  assert.equal(row.bzGsm, -3.2);

  const bad = createSpaceWeatherSource({
    fetchImpl: async () => ({ ok: false, status: 503 }),
  });
  await assert.rejects(bad.getSnapshot(), /503/);

  const malformed = createSpaceWeatherSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(malformed.getSnapshot(), /Malformed/);
});

function harness(source) {
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
  const layer = createSpaceWeatherLayer({ source });
  layer.init(viewer);
  layer.enable(viewer);
  return { layer, viewer, sources };
}

test('layer shape matches the catalog contract', () => {
  const h = harness({ getSnapshot: async () => ({}) });
  assert.equal(h.layer.id, 'space-weather');
  assert.equal(h.layer.name, 'Solar Wind');
  assert.equal(h.layer.icon, '☀️');
  assert.equal(h.layer.source, 'NOAA SWPC');
  assert.equal(h.layer.updateInterval, 300000);
  h.layer.destroy(h.viewer);
});

test('layer plots the subsolar entity and fails soft', async () => {
  const h = harness({
    getSnapshot: async () => ({
      timeMs: Date.parse('2026-09-26T21:00:00Z'),
      speedKms: 452.4,
      densityPerCm3: 6.1,
      tempK: 120000,
      bzGsm: -3.17,
    }),
  });
  assert.equal(await h.layer.update(h.viewer), true);
  const stats = h.layer.getStats();
  assert.equal(stats.speedKms, 452.4);
  assert.equal(stats.bzGsm, -3.17);
  assert.equal(stats.error, null);
  const entities = h.sources[0].entities.values;
  assert.equal(entities.length, 1);
  assert.equal(entities[0].id, 'space-weather:subsolar');
  assert.ok(entities[0].point instanceof Cesium.PointGraphics || entities[0].point);
  const records = h.layer.getAnalystRecords();
  assert.equal(records.length, 1);
  assert.equal(records[0].type, 'space-weather');
  h.layer.disable(h.viewer);
  assert.equal(h.layer.getStats().error, null);
  h.layer.destroy(h.viewer);
  assert.equal(h.sources.length, 0);

  const failing = harness({
    getSnapshot: async () => {
      throw new Error('swpc down');
    },
  });
  assert.equal(await failing.layer.update(failing.viewer), false);
  assert.match(failing.layer.getStats().error, /swpc down/);
  failing.layer.destroy(failing.viewer);
});
