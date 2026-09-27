import assert from 'node:assert/strict';
import test from 'node:test';
import { parseWatchQuery, resolveWatchCenter, evaluateWatch } from './watches.js';
import { evaluateWatchEntry } from './index.js';
import { parseCron, nextRun, describeCron, createScheduler } from './scheduler.js';
import { appendEvents, readDay, quakeRowsToEvents, pruneDays, listDayKeys, dayKey } from './eventLog.js';
import { createReplay } from './replay.js';

// — watches.js —

test('parseWatchQuery: parses "alert me when M7+ within 500 km of Tokyo"', () => {
  const w = parseWatchQuery('alert me when M7+ within 500 km of Tokyo');
  assert.equal(w.kind, 'quake');
  assert.equal(w.minMag, 7);
  assert.equal(w.radiusKm, 500);
  assert.equal(w.placeQuery, 'Tokyo');
});

test('parseWatchQuery: matches river by name against the registry', () => {
  const w = parseWatchQuery('notify me when the Mississippi at St. Louis floods', {
    riverRegistry: [{ site: '07010000', name: 'Mississippi R. at St. Louis' }],
  });
  assert.equal(w.kind, 'river');
  assert.equal(w.riverSite, '07010000');
});

test('parseWatchQuery: unknown river name keeps the query as custom-ish river', () => {
  const w = parseWatchQuery('tell me when the Nile floods');
  assert.equal(w.kind, 'river');
  assert.equal(w.riverSite, null);
});

test('parseWatchQuery: free text becomes custom', () => {
  const w = parseWatchQuery('ping me about volcanoes');
  assert.equal(w.kind, 'custom');
  assert.equal(w.text, 'ping me about volcanoes');
});

test('resolveWatchCenter: stub geocoder resolves the place', async () => {
  const w = parseWatchQuery('alert me when M7+ within 500 km of Tokyo');
  const resolved = await resolveWatchCenter(w, {
    geocode: async (q) => ({ lat: 35.7, lon: 139.7, label: q }),
  });
  assert.deepEqual(resolved.center, { lat: 35.7, lon: 139.7, label: 'Tokyo' });
});

test('resolveWatchCenter: unresolvable place returns null', async () => {
  const w = parseWatchQuery('alert me when M7+ within 500 km of Nowhere');
  const resolved = await resolveWatchCenter(w, { geocode: async () => null });
  assert.equal(resolved, null);
});

test('evaluateWatch: quake watch fires on an M7 inside the radius', () => {
  const watch = { kind: 'quake', minMag: 7, radiusKm: 500, center: { lat: 35.7, lon: 139.7, label: 'Tokyo' } };
  const out = evaluateWatch(watch, {
    quakes: [{ mag: 7.2, lat: 36.0, lon: 140.5, place: 'offshore', timeMs: 1 }],
  });
  assert.equal(out.fired, true);
  assert.match(out.detail, /M7\.2/);
});

test('evaluateWatch: quake watch does not fire outside the radius', () => {
  const watch = { kind: 'quake', minMag: 7, radiusKm: 500, center: { lat: 35.7, lon: 139.7, label: 'Tokyo' } };
  const out = evaluateWatch(watch, {
    quakes: [{ mag: 7.2, lat: -33.0, lon: -72.0, place: 'Chile', timeMs: 1 }],
  });
  assert.equal(out.fired, false);
});

test('evaluateWatch: river watch fires at minor-flood band or worse', () => {
  const watch = { kind: 'river', riverSite: '07010000', riverName: 'Mississippi R. at St. Louis' };
  assert.equal(evaluateWatch(watch, { rivers: [{ site: '07010000', band: 'minor-flood', gageFt: 31 }] }).fired, true);
  assert.equal(evaluateWatch(watch, { rivers: [{ site: '07010000', band: 'action', gageFt: 28 }] }).fired, false);
  assert.equal(evaluateWatch(watch, { rivers: [] }).fired, false);
});

test('evaluateWatch: custom watch reports needsReview, never fires silently', () => {
  const out = evaluateWatch({ kind: 'custom', text: 'x' }, {});
  assert.equal(out.fired, false);
  assert.equal(out.needsReview, true);
});

// — index.js: scheduler entry → condition wiring (regression) —

const liveQuake = (mag, lat, lon) => async () => ({
  quakes: [{ mag, lat, lon, place: 'offshore', timeMs: 1 }],
  rivers: [],
});

test('evaluateWatchEntry: scheduler entry fires on its condition, not the wrapper', async () => {
  // Regression: the scheduler hands tick() the stored ENTRY ({id, schedule,
  // condition}); evaluating the entry itself silently degraded every watch
  // to kind:'custom' so nothing ever fired.
  const entry = {
    id: 'w1',
    schedule: '*/15 * * * *',
    condition: {
      kind: 'quake', minMag: 7, radiusKm: 500,
      center: { lat: 35.7, lon: 139.7, label: 'Tokyo' },
    },
  };
  const out = await evaluateWatchEntry(entry, {
    geocode: async () => { throw new Error('must not geocode a resolved watch'); },
    fetchLiveData: liveQuake(7.2, 36.0, 140.5),
  });
  assert.equal(out.fired, true);
  assert.match(out.detail, /M7\.2/);
});

test('evaluateWatchEntry: entry-wrapped river condition fires at minor-flood', async () => {
  const entry = {
    id: 'w2',
    condition: { kind: 'river', riverSite: '07010000', riverName: 'Mississippi R. at St. Louis' },
  };
  const out = await evaluateWatchEntry(entry, {
    geocode: async () => null,
    fetchLiveData: async () => ({
      quakes: [],
      rivers: [{ site: '07010000', name: 'Mississippi R. at St. Louis', band: 'minor-flood', gageFt: 31 }],
    }),
  });
  assert.equal(out.fired, true);
  assert.match(out.detail, /Mississippi/);
});

test('evaluateWatchEntry: unresolvable quake place reports geocode failure, never throws', async () => {
  const entry = {
    id: 'w3',
    condition: { kind: 'quake', minMag: 7, radiusKm: 500, placeQuery: 'Nowhere', center: null },
  };
  const out = await evaluateWatchEntry(entry, {
    geocode: async () => null,
    fetchLiveData: liveQuake(9.0, 35.7, 139.7),
  });
  assert.equal(out.fired, false);
  assert.match(out.detail, /geocod/);
});

// — scheduler.js —

test('parseCron: accepts standard forms, rejects the rest', () => {
  assert.ok(parseCron('*/15 * * * *'));
  assert.ok(parseCron('0 8 * * *'));
  assert.equal(parseCron('0 8 * * 1'), null, 'dow restricted days are unsupported');
  assert.equal(parseCron('every 15 minutes'), null);
  assert.equal(parseCron('*/70 * * * *'), null, 'minute step out of range');
});

test('nextRun: */15 fires on the next quarter hour', () => {
  const from = Date.UTC(2026, 8, 27, 1, 2, 30); // 01:02:30
  const t = nextRun('*/15 * * * *', from);
  assert.equal(new Date(t).toISOString(), '2026-09-27T01:15:00.000Z');
});

test('nextRun: fixed time tomorrow when passed', () => {
  const from = Date.UTC(2026, 8, 27, 9, 0, 0);
  const t = nextRun('0 8 * * *', from);
  assert.equal(new Date(t).toISOString(), '2026-09-28T08:00:00.000Z');
});

test('describeCron: human-readable', () => {
  assert.match(describeCron('*/15 * * * *'), /every 15 min/);
  assert.match(describeCron('bogus'), /invalid/);
});

test('scheduler: tick evaluates due watches and records firings', async () => {
  const mem = new Map();
  const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  let nowMs = Date.UTC(2026, 8, 27, 1, 0, 0);
  const calls = [];
  const sched = createScheduler({
    storage,
    now: () => nowMs,
    id: () => `w${calls.length + 1}`,
    evaluate: async (watch) => { calls.push(watch.id); return { fired: true, detail: 'boom' }; },
  });
  const w = sched.add({ raw: 'test', condition: { kind: 'custom' }, schedule: '* * * * *' });
  assert.ok(w.nextDue > nowMs);
  nowMs = w.nextDue; // fast-forward to due
  const results = await sched.tick(nowMs);
  assert.equal(results.length, 1);
  assert.equal(results[0].fired, true);
  const after = sched.list()[0];
  assert.equal(after.firings.length, 1);
  assert.equal(after.lastFired, nowMs);
  assert.ok(after.nextDue > nowMs, 'rescheduled past this tick');
});

test('scheduler: a throwing evaluate does not kill the tick', async () => {
  const mem = new Map();
  const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  const nowMs = Date.UTC(2026, 8, 27, 1, 0, 0);
  const sched = createScheduler({
    storage,
    now: () => nowMs,
    id: () => 'w1',
    evaluate: async () => { throw new Error('upstream down'); },
  });
  const w = sched.add({ raw: 'x', condition: {}, schedule: '* * * * *' });
  const results = await sched.tick(w.nextDue);
  assert.equal(results[0].ok, false);
  assert.match(results[0].detail, /upstream down/);
});

test('scheduler: disabled watches are skipped', async () => {
  const mem = new Map();
  const storage = { get: (k) => mem.get(k) ?? null, set: (k, v) => mem.set(k, v) };
  let evaluated = 0;
  const sched = createScheduler({
    storage,
    now: () => Date.UTC(2026, 8, 27, 1, 0, 0),
    id: () => 'w1',
    evaluate: async () => { evaluated++; return { fired: false }; },
  });
  const w = sched.add({ raw: 'x', condition: {}, schedule: '* * * * *' });
  sched.setEnabled(w.id, false);
  const results = await sched.tick(w.nextDue);
  assert.deepEqual(results, []);
  assert.equal(evaluated, 0);
});

// — eventLog.js —

function memStore() {
  const map = new Map();
  return {
    get: (k) => (map.has(k) ? map.get(k) : null),
    set: (k, v) => { map.set(k, v); },
    remove: (k) => { map.delete(k); },
    keys: () => [...map.keys()],
  };
}

test('eventLog: append + read round-trip, chronological', () => {
  const s = memStore();
  appendEvents(s, '2026-09-26', [
    { t: 3, type: 'quake', lat: 1, lon: 2, label: 'c' },
    { t: 1, type: 'quake', lat: 1, lon: 2, label: 'a' },
    { t: 2, type: 'quake', lat: 1, lon: 2, label: 'b' },
  ]);
  const events = readDay(s, '2026-09-26');
  assert.deepEqual(events.map((e) => e.label), ['a', 'b', 'c']);
});

test('eventLog: duplicates dropped, bad events skipped', () => {
  const s = memStore();
  const n = appendEvents(s, '2026-09-26', [
    { t: 1, type: 'quake', lat: 1, lon: 2, label: 'a' },
    { t: 1, type: 'quake', lat: 1, lon: 2, label: 'a' },
    { t: 2, type: 'quake', lat: NaN, lon: 2, label: 'bad' },
  ]);
  assert.equal(n, 1);
});

test('eventLog: dayKey format and key listing', () => {
  assert.equal(dayKey(new Date(Date.UTC(2026, 8, 27, 12))), 'satwq.eventlog.2026-09-27');
  const s = memStore();
  appendEvents(s, '2026-09-26', [{ t: 1, type: 'quake', lat: 1, lon: 2, label: 'a' }]);
  assert.deepEqual(listDayKeys(s), ['satwq.eventlog.2026-09-26']);
});

test('eventLog: pruneDays drops old days', () => {
  const s = memStore();
  appendEvents(s, '2020-01-01', [{ t: 1, type: 'quake', lat: 1, lon: 2, label: 'old' }]);
  appendEvents(s, new Date(), [{ t: 1, type: 'quake', lat: 1, lon: 2, label: 'new' }]);
  const dropped = pruneDays(s, 30);
  assert.equal(dropped, 1);
  assert.equal(listDayKeys(s).length, 1);
});

test('eventLog: quakeRowsToEvents maps USGS rows', () => {
  const events = quakeRowsToEvents([
    { mag: 6.5, lat: 52.9, lon: -171.5, place: 'Alaska', timeMs: 123, depthKm: 33 },
    { mag: null, lat: 0, lon: 0, place: 'bad', timeMs: 1 },
  ]);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'quake');
  assert.equal(events[0].mag, 6.5);
  assert.equal(events[0].source, 'usgs');
  assert.match(events[0].label, /M6\.5/);
});

// — replay.js —

test('replay: playDay steps events in chronological order with all three subsystems', async () => {
  const seen = { steps: [], scrubs: [], sounds: [] };
  const replay = createReplay({
    viewer: null, // camera skipped without a viewer
    dvr: { goTo: (t) => seen.scrubs.push(t) },
    sonify: { quakeSound: ({ magnitude }) => seen.sounds.push(magnitude) },
  });
  const events = [
    { t: 300, type: 'quake', lat: 10, lon: 20, label: 'third', mag: 5.1 },
    { t: 100, type: 'quake', lat: 11, lon: 21, label: 'first', mag: 6.2 },
    { t: 200, type: 'quake', lat: 12, lon: 22, label: 'second', mag: 5.5 },
  ];
  const ctl = replay.playDay({
    day: '2026-09-26',
    events,
    speed: 100, // minimum wall gap 120ms keeps the test fast but real
    onStep: (e, i, n) => seen.steps.push(`${i + 1}/${n}:${e.label}`),
  });
  const result = await ctl.done;
  assert.equal(result.played, 3);
  assert.deepEqual(seen.steps, ['1/3:first', '2/3:second', '3/3:third']);
  assert.deepEqual(seen.scrubs, [100, 200, 300]);
  assert.deepEqual(seen.sounds, [6.2, 5.5, 5.1]);
});

test('replay: stop() cancels mid-play', async () => {
  const replay = createReplay({ viewer: null });
  const events = Array.from({ length: 10 }, (_, i) => ({ t: i, type: 'quake', lat: 0, lon: 0, label: `e${i}` }));
  const ctl = replay.playDay({ day: 'x', events, speed: 1 });
  ctl.stop();
  const result = await ctl.done;
  assert.equal(result.stopped, true);
  assert.ok(result.played <= 1);
});
