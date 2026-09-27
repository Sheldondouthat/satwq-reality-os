import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TourDirector,
  FLY_DURATION_S,
  HOLD_DURATION_S,
  SPIN_RATE_DEG_S,
  REGION_VIEWS,
} from './tourDirector.js';

/** Stub viewer whose camera records every flyTo/setView/cancelFlight call. */
function makeStubViewer() {
  const calls = [];
  return {
    calls,
    camera: {
      flyTo(opts) {
        calls.push({ kind: 'flyTo', ...opts });
      },
      setView(opts) {
        calls.push({ kind: 'setView', ...opts });
      },
      cancelFlight() {
        calls.push({ kind: 'cancelFlight' });
      },
    },
  };
}

/** Fake timer queue + fake clock. */
function makeClock() {
  let nowMs = 1_000_000;
  const queue = [];
  let seq = 0;
  const api = {
    now: () => nowMs,
    schedule(fn, ms) {
      const id = ++seq;
      queue.push({ id, at: nowMs + ms, fn });
      return id;
    },
    cancelSchedule(id) {
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
    },
    /** Advance the clock, firing every due timer in order. */
    advance(ms) {
      const end = nowMs + ms;
      for (;;) {
        queue.sort((a, b) => a.at - b.at || a.id - b.id);
        const next = queue[0];
        if (!next || next.at > end) break;
        queue.shift();
        nowMs = next.at;
        next.fn();
      }
      nowMs = end;
    },
    pending: () => queue.length,
  };
  return api;
}

function makeDirector({ viewer, layers, enabled, clock, destinationFor } = {}) {
  const v = viewer ?? makeStubViewer();
  const layerList = layers ?? [
    { id: 'aurora' },
    { id: 'firms' },
    { id: 'unmapped-thing' },
  ];
  const enabledSet = new Set(enabled ?? ['aurora', 'firms']);
  return {
    viewer: v,
    director: new TourDirector({
      viewer: v,
      getLayers: () => layerList,
      isEnabled: (id) => enabledSet.has(id),
      requestRender: () => {},
      now: clock?.now ?? (() => 0),
      schedule: clock?.schedule ?? ((fn, ms) => setTimeout(fn, ms)),
      cancelSchedule: clock?.cancelSchedule ?? ((id) => clearTimeout(id)),
      ...(destinationFor ? { destinationFor } : {}),
    }),
  };
}

test('buildStops maps enabled layers to cinematic views and skips unmapped ids', () => {
  const { director } = makeDirector();
  const stops = director.buildStops();
  assert.equal(stops.length, 2);
  assert.deepEqual(stops.map((s) => s.layerId), ['aurora', 'firms']);
  assert.ok(stops[0].label.includes('Aurora'));
  assert.equal(stops[0].view.latitude, REGION_VIEWS.northPolar.latitude);
  assert.equal(stops[0].view.heightM, REGION_VIEWS.northPolar.heightM);
});

test('buildStops skips layers that are not enabled', () => {
  const { director } = makeDirector({ enabled: ['aurora'] });
  const stops = director.buildStops();
  assert.deepEqual(stops.map((s) => s.layerId), ['aurora']);
});

test('prefix mapping matches gibs-* and rainviewer-* ids', () => {
  const { director } = makeDirector({
    layers: [{ id: 'gibs-modis-terra' }, { id: 'rainviewer-radar' }],
    enabled: ['gibs-modis-terra', 'rainviewer-radar'],
  });
  const stops = director.buildStops();
  assert.equal(stops.length, 2);
  assert.ok(stops.every((s) => s.view.spin === true));
});

test('start returns false with no stops and does not fly', () => {
  const { viewer, director } = makeDirector({ layers: [], enabled: [] });
  assert.equal(director.start(), false);
  assert.equal(director.running, false);
  assert.equal(viewer.calls.length, 0);
});

test('start flies to first stop with sane duration and orientation', () => {
  const { viewer, director } = makeDirector();
  assert.equal(director.start(), true);
  assert.equal(director.running, true);
  const fly = viewer.calls.find((c) => c.kind === 'flyTo');
  assert.ok(fly, 'expected a flyTo call');
  assert.equal(fly.duration, FLY_DURATION_S);
  assert.ok(fly.destination && typeof fly.destination === 'object');
  assert.ok(Math.abs(fly.orientation.heading - 0) < 1e-9);
  // aurora pitch -70° → radians
  assert.ok(Math.abs(fly.orientation.pitch - -70 * (Math.PI / 180)) < 1e-9);
  assert.equal(fly.orientation.roll, 0);
  // second start() while running is a no-op
  assert.equal(director.start(), false);
});

test('complete → hold → advance → next stop, loop wraps around', () => {
  const clock = makeClock();
  const { viewer, director } = makeDirector({ clock });
  assert.equal(director.start(), true);

  // Complete the first flight → hold 4s → second flight.
  const first = viewer.calls.find((c) => c.kind === 'flyTo');
  first.complete();
  clock.advance(HOLD_DURATION_S * 1000);
  const flights = viewer.calls.filter((c) => c.kind === 'flyTo');
  assert.equal(flights.length, 2);
  assert.equal(director.currentStop.layerId, 'firms');

  // Complete the second flight → hold → wrap to first stop.
  flights[1].complete();
  clock.advance(HOLD_DURATION_S * 1000);
  const flightsAfter = viewer.calls.filter((c) => c.kind === 'flyTo');
  assert.equal(flightsAfter.length, 3);
  assert.equal(director.currentStop.layerId, 'aurora');
});

test('spin stops drift longitude via setView during the hold', () => {
  const clock = makeClock();
  const { viewer, director } = makeDirector({
    clock,
    layers: [{ id: 'gibs-modis-terra' }],
    enabled: ['gibs-modis-terra'],
  });
  director.start();
  const fly = viewer.calls.find((c) => c.kind === 'flyTo');
  fly.complete();
  clock.advance(2500); // 2 spin ticks at 1s each, still inside the 4s hold
  const spins = viewer.calls.filter((c) => c.kind === 'setView');
  assert.ok(spins.length >= 2, `expected ≥2 setView calls, got ${spins.length}`);
  const lon0 = fly.destination.longitude;
  const lon1 = spins[0].destination.longitude;
  assert.ok(Math.abs(lon1 - lon0 - SPIN_RATE_DEG_S) < 1e-9);
});

test('stop cancels flight, clears timers, and is idempotent-ish', () => {
  const clock = makeClock();
  const { viewer, director } = makeDirector({ clock });
  assert.equal(director.stop(), false); // idle stop is a no-op
  director.start();
  const fly = viewer.calls.find((c) => c.kind === 'flyTo');
  fly.complete();
  assert.ok(clock.pending() > 0);
  assert.equal(director.stop(), true);
  assert.equal(director.running, false);
  assert.equal(clock.pending(), 0);
  assert.ok(viewer.calls.some((c) => c.kind === 'cancelFlight'));
  // Advancing time after stop fires nothing new.
  const before = viewer.calls.length;
  clock.advance(60_000);
  assert.equal(viewer.calls.length, before);
});

test('tour ends itself when all layers are disabled mid-tour', () => {
  const clock = makeClock();
  const enabledSet = new Set(['aurora']);
  const v = makeStubViewer();
  const director = new TourDirector({
    viewer: v,
    getLayers: () => [{ id: 'aurora' }],
    isEnabled: (id) => enabledSet.has(id),
    now: clock.now,
    schedule: clock.schedule,
    cancelSchedule: clock.cancelSchedule,
  });
  director.start();
  enabledSet.delete('aurora');
  v.calls.find((c) => c.kind === 'flyTo').complete();
  clock.advance(HOLD_DURATION_S * 1000);
  assert.equal(director.running, false);
});

test('live-data coordinates produce a close-up instead of the regional fallback', () => {
  const { director } = makeDirector({
    layers: [{ id: 'firms', getStats: () => ({ latest: { lat: 34.05, lon: -118.25 } }) }],
    enabled: ['firms'],
  });
  const stops = director.buildStops();
  assert.equal(stops.length, 1);
  assert.ok(Math.abs(stops[0].view.latitude - 34.05) < 1e-9);
  assert.ok(Math.abs(stops[0].view.longitude - -118.25) < 1e-9);
  assert.ok(stops[0].view.heightM < REGION_VIEWS.conus.heightM);
});

test('destinationFor hook converts views for a real camera', () => {
  const seen = [];
  const { director } = makeDirector({
    destinationFor: (view) => {
      const d = { cartesian: [view.longitude, view.latitude, view.heightM] };
      seen.push(d);
      return d;
    },
  });
  director.start();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].cartesian[0], -100);
});
