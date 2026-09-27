import assert from 'node:assert/strict';
import test from 'node:test';
import { createTidesLayer, TIDE_STATIONS } from './index.js';
import { createTideSource } from './source.js';
import {
  normalizeTidePredictions,
  nextTideEvents,
  tideTrend,
} from './records.js';
import { createTideOverlayEntry } from './model.js';

const T0 = Date.parse('2026-09-26T12:00:00Z');
const ev = (iso, v, type) => ({
  t: Date.parse(iso),
  v,
  type,
});
const payload = () => ({
  predictions: [
    { t: '2026-09-26 03:10', v: '0.361', type: 'L' },
    { t: '2026-09-26 09:23', v: '3.164', type: 'H' },
    { t: '2026-09-26 15:43', v: '0.414', type: 'L' },
    { t: '2026-09-26 21:41', v: '2.980', type: 'H' },
  ],
});

test('normalizeTidePredictions parses and sorts events', () => {
  const events = normalizeTidePredictions(payload());
  assert.equal(events.length, 4);
  assert.ok(events[0].t < events[1].t);
  assert.equal(events[1].type, 'H');
  assert.equal(events[1].v, 3.164);
});

test('normalizeTidePredictions rejects malformed payloads', () => {
  assert.equal(normalizeTidePredictions(null), null);
  assert.equal(normalizeTidePredictions({}), null);
  assert.equal(
    normalizeTidePredictions({ predictions: [{ t: 'x', v: '1', type: 'H' }] }),
    null,
  );
  assert.equal(
    normalizeTidePredictions({ predictions: [{ t: '2026-09-26 03:10', v: '1', type: 'X' }] }),
    null,
  );
});

test('next events and trend derive from the event list', () => {
  const events = [
    ev('2026-09-26T03:10:00Z', 0.36, 'L'),
    ev('2026-09-26T09:23:00Z', 3.16, 'H'),
    ev('2026-09-26T15:43:00Z', 0.41, 'L'),
  ];
  const eight = Date.parse('2026-09-26T08:00:00Z');
  const { nextHigh, nextLow } = nextTideEvents(events, eight);
  assert.equal(nextHigh.v, 3.16);
  assert.equal(nextLow.v, 0.41);
  assert.equal(tideTrend(events, eight), 'rising');
  assert.equal(tideTrend(events, Date.parse('2026-09-26T10:00:00Z')), 'falling');
  assert.equal(tideTrend(events, Date.parse('2026-09-26T01:00:00Z')), 'unknown');
});

test('overlay entry summarizes next high/low', () => {
  const entry = createTideOverlayEntry({
    id: '8454000',
    position: null,
    name: 'Providence, RI',
    events: normalizeTidePredictions(payload()),
    nowMs: Date.parse('2026-09-26T12:00:00Z'),
    accent: '#0ff',
  });
  assert.match(entry.subtitle, /High 3.0 ft/);
  assert.match(entry.subtitle, /Low 0.4 ft/);
});

test('source skips failing stations but keeps the good ones', async () => {
  const source = createTideSource({
    stations: [
      { id: 'good', name: 'Good', lat: 40, lon: -70 },
      { id: 'bad', name: 'Bad', lat: 41, lon: -71 },
    ],
    fetchImpl: async (url) => {
      if (url.includes('station=bad')) throw new Error('nope');
      return { ok: true, json: async () => payload() };
    },
    now: () => T0,
  });
  const rows = await source.getSnapshot();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].stationId, 'good');
  assert.equal(rows[0].events.length, 4);
});

test('source honors abort between stations', async () => {
  const abort = new AbortController();
  const source = createTideSource({
    stations: [
      { id: 'a', name: 'A', lat: 40, lon: -70 },
      { id: 'b', name: 'B', lat: 41, lon: -71 },
    ],
    fetchImpl: async () => {
      abort.abort();
      return { ok: true, json: async () => payload() };
    },
    now: () => T0,
  });
  await assert.rejects(source.getSnapshot({ signal: abort.signal }), {
    name: 'AbortError',
  });
});

test('curated stations carry coordinates', () => {
  assert.ok(TIDE_STATIONS.length >= 9);
  for (const s of TIDE_STATIONS) {
    assert.ok(Number.isFinite(s.lat) && Number.isFinite(s.lon));
    assert.ok(typeof s.id === 'string' && s.id.length > 0);
  }
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
  const layer = createTidesLayer({
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

test('layer publishes stations and fails soft on upstream errors', async () => {
  const h = harness({
    getSnapshot: async () => [
      {
        stableId: '8454000',
        stationId: '8454000',
        name: 'Providence, RI',
        lon: -71.4,
        lat: 41.8,
        events: normalizeTidePredictions(payload()),
      },
    ],
  });
  assert.equal(await h.layer.update(h.viewer), true);
  assert.equal(h.layer.getStats().count, 1);
  assert.equal(h.events.length, 1);
  h.layer.destroy(h.viewer);

  const empty = harness({ getSnapshot: async () => [] });
  assert.equal(await empty.layer.update(empty.viewer), true);
  assert.equal(empty.layer.getStats().count, 0);
  empty.layer.destroy(empty.viewer);
});
