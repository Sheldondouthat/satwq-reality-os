import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAkashicEvent,
  isAkashicEvent,
  AKASHIC_MAX_EVENTS,
} from './schema.js';
import {
  earthquakeRowsToEvents,
  volcanoRowsToEvents,
  meteorRowsToEvents,
  gmstDegrees,
  radiantSubpoint,
} from './adapters.js';
import { createAkashicStore, createMemoryBackend } from './store.js';
import { createAkashicRecorder } from './recorder.js';
import {
  bucketizeEvents,
  filterEventsUpTo,
  formatCutoff,
} from './timeline.js';
import { createReplayController } from './replay.js';

const quakeRow = (overrides = {}) => ({
  stableId: 'us123',
  usgsId: 'us123',
  lon: -120.5,
  lat: 35.2,
  depthKm: 10,
  mag: 5.4,
  place: 'California',
  time: 1759000000000,
  ...overrides,
});

test('schema accepts a valid event and normalizes fields', () => {
  const event = normalizeAkashicEvent({
    id: 'quake:us123',
    time: 1759000000000.7,
    type: 'Earthquake',
    layer: 'earthquakes',
    title: 'M5.4 — California',
    lat: 35.2,
    lon: -120.5,
    magnitude: 5.4,
    severity: 1.7,
    source: 'USGS',
  });
  assert.ok(event);
  assert.equal(event.time, 1759000000000);
  assert.equal(event.type, 'earthquake');
  assert.equal(event.severity, 1); // clamped
  assert.equal(event.url, null);
  assert.ok(isAkashicEvent(event));
});

test('schema rejects bad ids, times, types, and coordinates', () => {
  const base = {
    id: 'x:1',
    time: 1759000000000,
    type: 'earthquake',
    layer: 'earthquakes',
    title: 't',
    lat: 0,
    lon: 0,
  };
  assert.equal(normalizeAkashicEvent({ ...base, id: '' }), null);
  assert.equal(normalizeAkashicEvent({ ...base, time: NaN }), null);
  assert.equal(normalizeAkashicEvent({ ...base, type: 'ufo' }), null);
  assert.equal(normalizeAkashicEvent({ ...base, lat: 91 }), null);
  assert.equal(normalizeAkashicEvent({ ...base, lon: -181 }), null);
  assert.equal(normalizeAkashicEvent(null), null);
});

test('earthquake adapter maps rows with severity scaled from magnitude', () => {
  const events = earthquakeRowsToEvents([
    quakeRow(),
    quakeRow({ usgsId: 'us124', mag: 2.0, time: 1759000001000 }),
    null,
  ]);
  assert.equal(events.length, 2);
  assert.equal(events[0].id, 'quake:us123');
  assert.match(events[0].title, /M5\.4/);
  assert.ok(events[0].severity > events[1].severity);
  assert.equal(events[0].source, 'USGS');
  assert.match(events[0].url, /us123/);
});

test('volcano adapter only emits elevated color codes', () => {
  const row = (code) => ({
    stableId: '332010',
    name: 'Kilauea',
    lon: -155.6,
    lat: 19.4,
    alertLevel: 'WATCH',
    colorCode: code,
  });
  const events = volcanoRowsToEvents(
    [row('GREEN'), row('ORANGE'), row('RED'), row('UNASSIGNED')],
    { now: () => 1759000000000 },
  );
  assert.equal(events.length, 2);
  assert.ok(events.every((e) => e.type === 'volcano'));
  assert.ok(events[0].severity < events[1].severity); // ORANGE < RED
  assert.match(events[1].title, /RED/);
});

test('meteor adapter anchors peaks at the radiant subpoint', () => {
  const rows = [
    { stableId: 'g', shower: { name: 'Geminids', peakMonth: 12, peakDay: 13, ra: 7.5, dec: 32.9, zhr: 150 } },
  ];
  const events = meteorRowsToEvents(rows, { now: () => Date.UTC(2026, 5, 1) });
  assert.equal(events.length, 1);
  const [event] = events;
  assert.equal(event.type, 'meteor');
  assert.equal(event.lat, 32.9); // subpoint latitude == declination
  assert.ok(event.lon >= -180 && event.lon <= 180);
  assert.equal(event.time, Date.UTC(2026, 11, 13, 12));
  assert.match(event.id, /geminids:2026/);
});

test('gmstDegrees wraps into 0..360', () => {
  const g = gmstDegrees(Date.UTC(2026, 0, 1));
  assert.ok(g >= 0 && g < 360);
  const sub = radiantSubpoint(0, 45, Date.UTC(2026, 0, 1));
  assert.equal(sub.lat, 45);
});

test('store dedups by id and prunes oldest beyond the cap', async () => {
  const store = createAkashicStore({ cap: 3, backend: createMemoryBackend() });
  const mk = (id, time) =>
    normalizeAkashicEvent({ id, time, type: 'earthquake', layer: 'earthquakes', title: id, lat: 0, lon: 0 });
  assert.equal(await store.recordEvents([mk('a', 100), mk('b', 200)]), 2);
  assert.equal(await store.recordEvents([mk('a', 100), mk('c', 300)]), 1); // 'a' is a dupe
  assert.equal(await store.count(), 3);
  assert.equal(await store.recordEvents([mk('d', 400)]), 1);
  assert.equal(await store.count(), 3); // pruned back to cap
  const all = await store.getAll();
  assert.deepEqual(all.map((e) => e.id).sort(), ['b', 'c', 'd']); // oldest ('a') evicted
});

test('store getRange and exportJson', async () => {
  const store = createAkashicStore({ backend: createMemoryBackend() });
  const mk = (id, time) =>
    normalizeAkashicEvent({ id, time, type: 'meteor', layer: 'meteors', title: id, lat: 10, lon: 10 });
  await store.recordEvents([mk('a', 1000), mk('b', 2000), mk('c', 3000)]);
  const range = await store.getRange(1500, 2500);
  assert.deepEqual(range.map((e) => e.id), ['b']);
  const parsed = JSON.parse(await store.exportJson());
  assert.equal(parsed.count, 3);
  assert.equal(parsed.events.length, 3);
  assert.ok(parsed.exportedAt);
});

test('store falls back to memory when IndexedDB is absent', async () => {
  const store = createAkashicStore(); // no backend injected; node has no indexedDB
  const event = normalizeAkashicEvent({
    id: 'x:1', time: 999, type: 'custom', layer: 'test', title: 't', lat: 1, lon: 1,
  });
  assert.equal(await store.recordEvents([event]), 1);
  assert.equal(store.backendKind, 'memory');
  assert.equal(store.degraded, true);
  assert.equal(await store.count(), 1);
});

test('recorder polls, dedups, and notifies subscribers', async () => {
  const store = createAkashicStore({ backend: createMemoryBackend() });
  const batch = () => [
    normalizeAkashicEvent({ id: 'q:1', time: 100, type: 'earthquake', layer: 'earthquakes', title: 't', lat: 0, lon: 0 }),
  ];
  let calls = 0;
  const recorder = createAkashicRecorder({
    store,
    pollers: [{ id: 'quakes', intervalMs: 60000, poll: async () => batch() }],
    setIntervalImpl: (fn) => { calls += 1; return calls; },
    clearIntervalImpl: () => {},
  });
  const seen = [];
  recorder.onEvents((n) => seen.push(n));
  assert.equal(await recorder.pollOnce({ id: 'quakes', intervalMs: 1, poll: async () => batch() }), 1);
  assert.equal(await recorder.pollOnce({ id: 'quakes', intervalMs: 1, poll: async () => batch() }), 0); // dupe
  assert.deepEqual(seen, [1]);
  recorder.start();
  assert.equal(recorder.running, true);
  recorder.stop();
  assert.equal(recorder.running, false);
});

test('recorder survives a failing poller', async () => {
  const store = createAkashicStore({ backend: createMemoryBackend() });
  const failing = {
    id: 'bad',
    intervalMs: 60000,
    poll: async () => {
      throw new Error('upstream down');
    },
  };
  const recorder = createAkashicRecorder({ store, pollers: [failing] });
  assert.equal(await recorder.pollOnce(failing), 0);
  assert.match(recorder.lastError.bad, /upstream down/);
  assert.equal(await store.count(), 0);
});

test('timeline buckets density over the trailing window', () => {
  const nowMs = 1759000000000;
  const mk = (id, time) => ({ id, time });
  const { buckets, max, windowStart, windowEnd } = bucketizeEvents(
    [mk('a', nowMs - 1000), mk('b', nowMs - 2000), mk('c', nowMs - 40 * 86400000)],
    { days: 30, bucketCount: 10, now: () => nowMs },
  );
  assert.equal(windowEnd, nowMs);
  assert.equal(windowStart, nowMs - 30 * 86400000);
  assert.equal(buckets.length, 10);
  const total = buckets.reduce((n, b) => n + b.count, 0);
  assert.equal(total, 2); // the 40-day-old event falls outside the window
  assert.equal(max, 2);
});

test('filterEventsUpTo returns events at/before the cutoff, oldest first', () => {
  const events = [
    { id: 'c', time: 300 },
    { id: 'a', time: 100 },
    { id: 'b', time: 200 },
  ];
  const out = filterEventsUpTo(events, 200);
  assert.deepEqual(out.map((e) => e.id), ['a', 'b']);
  assert.deepEqual(filterEventsUpTo(events, 50), []);
  assert.ok(typeof formatCutoff(1759000000000) === 'string');
});

test('replay controller: scrub enters replay, Esc-path exits to live', () => {
  const replay = createReplayController({ now: () => 1000000 });
  const states = [];
  replay.subscribe((s) => states.push({ ...s }));
  assert.equal(replay.mode, 'live');
  replay.setCutoff(500000);
  assert.equal(replay.mode, 'replay');
  assert.equal(replay.cutoff, 500000);
  replay.exitToLive();
  assert.equal(replay.mode, 'live');
  assert.equal(replay.cutoff, 1000000);
  assert.ok(states.length >= 2);
});

test('replay controller: play advances the cutoff on fake timers', () => {
  let tick = null;
  const replay = createReplayController({
    now: () => 2000000,
    setIntervalImpl: (fn) => { tick = fn; return 1; },
    clearIntervalImpl: () => { tick = null; },
    tickMs: 100,
  });
  replay.play({ fromMs: 1000000, toMs: 1900000, msPerSecond: 3600000 });
  assert.equal(replay.playing, true);
  assert.equal(replay.mode, 'replay');
  const before = replay.cutoff;
  tick(); // +360000 ms per tick
  assert.equal(replay.cutoff, before + 360000);
  // Fast-forward to the end: playing stops and mode returns to live.
  replay.play({ fromMs: 1899999, toMs: 1900000, msPerSecond: 3600000 });
  tick();
  assert.equal(replay.playing, false);
  assert.equal(replay.mode, 'live');
});
