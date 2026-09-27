import assert from 'node:assert/strict';
import test from 'node:test';
import {
  haversineMeters,
  buildCableIndex,
  pointToSegmentMeters,
  nearestCable,
  SightingTracker,
  joinPass,
  CANDIDATE_DIST_M,
  LOITER_MIN_MS,
} from './model.js';

// One cable: a short E–W segment near (lon -70, lat 40).
const CABLES = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: { id: 'test-cable', name: 'Test Cable' },
      geometry: {
        type: 'MultiLineString',
        coordinates: [[[-70.05, 40.0], [-69.95, 40.0]]],
      },
    },
  ],
};

function vessel(over = {}) {
  return {
    mmsi: '123456789',
    name: 'TEST VESSEL',
    type: 'Cargo',
    lat: 40.001, // ~111 m north of the cable
    lon: -70.0,
    speed: 0.2,
    last_position_epoch: Math.floor(Date.now() / 1000) - 60,
    ...over,
  };
}

test('haversineMeters: 1° latitude ≈ 111 km', () => {
  const d = haversineMeters(40, -70, 41, -70);
  assert.ok(Math.abs(d - 111_195) < 500, `got ${d}`);
});

test('buildCableIndex flattens MultiLineString into indexed segments', () => {
  const index = buildCableIndex(CABLES);
  assert.equal(index.segments.length, 1);
  assert.equal(index.segments[0].cableId, 'test-cable');
  assert.equal(index.segments[0].cableName, 'Test Cable');
  assert.ok(index.grid.size > 0);
});

test('buildCableIndex skips non-MultiLineString features', () => {
  const index = buildCableIndex({
    type: 'FeatureCollection',
    features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [0, 0] } }],
  });
  assert.equal(index.segments.length, 0);
});

test('pointToSegmentMeters measures perpendicular distance', () => {
  const index = buildCableIndex(CABLES);
  const d = pointToSegmentMeters(40.001, -70.0, index.segments[0]);
  assert.ok(Math.abs(d - 111) < 5, `got ${d}`);
});

test('nearestCable finds the segment within 2 km, misses far away', () => {
  const index = buildCableIndex(CABLES);
  const hit = nearestCable(40.001, -70.0, index);
  assert.ok(hit);
  assert.ok(hit.distM < CANDIDATE_DIST_M);
  assert.equal(hit.segment.cableId, 'test-cable');
  const miss = nearestCable(45.0, -70.0, index);
  assert.equal(miss, null);
});

test('joinPass ignores fast vessels and vessels far from cables', () => {
  const index = buildCableIndex(CABLES);
  const tracker = new SightingTracker();
  const { candidates } = joinPass(
    [vessel({ speed: 12.0 }), vessel({ lat: 50, lon: -70 }), vessel({ speed: null })],
    index,
    tracker,
  );
  assert.equal(candidates.length, 0);
});

test('joinPass ignores stale position reports', () => {
  const index = buildCableIndex(CABLES);
  const tracker = new SightingTracker();
  const { candidates } = joinPass(
    [vessel({ last_position_epoch: Math.floor(Date.now() / 1000) - 7200 })],
    index,
    tracker,
  );
  assert.equal(candidates.length, 0);
});

test('sighting promotes to threat after 30 min slow and near-stationary', () => {
  const index = buildCableIndex(CABLES);
  const tracker = new SightingTracker();
  const t0 = Date.now();
  const t1 = t0 + LOITER_MIN_MS + 1000;
  const epochFor = (nowMs) => Math.floor(nowMs / 1000) - 60;
  joinPass([vessel({ last_position_epoch: epochFor(t0) })], index, tracker, t0);
  assert.equal(tracker.threats(t0).length, 0); // one sighting: watch only
  joinPass(
    [vessel({ lat: 40.0012, lon: -70.0001, last_position_epoch: epochFor(t1) })],
    index, tracker, t1,
  );
  const threats = tracker.threats(t1);
  assert.equal(threats.length, 1);
  assert.equal(threats[0].verdict, 'loiter-near-cable CANDIDATE');
  assert.ok(threats[0].maxDispM < 500);
  assert.ok(threats[0].note.includes('not proof of intent'));
});

test('sighting does NOT promote when the vessel drifted >500 m', () => {
  const index = buildCableIndex(CABLES);
  const tracker = new SightingTracker();
  const t0 = Date.now();
  const t1 = t0 + LOITER_MIN_MS + 1000;
  const epochFor = (nowMs) => Math.floor(nowMs / 1000) - 60;
  joinPass([vessel({ last_position_epoch: epochFor(t0) })], index, tracker, t0);
  joinPass(
    [vessel({ lat: 40.02, lon: -70.0, last_position_epoch: epochFor(t1) })], // ~2.2 km drift
    index, tracker, t1,
  );
  assert.equal(tracker.threats(t1).length, 0);
});

test('threat carries the segment reference for flashing', () => {
  const index = buildCableIndex(CABLES);
  const tracker = new SightingTracker();
  const t0 = Date.now();
  const t1 = t0 + LOITER_MIN_MS + 1000;
  const epochFor = (nowMs) => Math.floor(nowMs / 1000) - 60;
  joinPass([vessel({ last_position_epoch: epochFor(t0) })], index, tracker, t0);
  joinPass([vessel({ last_position_epoch: epochFor(t1) })], index, tracker, t1);
  const [threat] = tracker.threats(t1);
  assert.ok(threat.nearestSegRef);
  assert.equal(threat.nearestSegRef.cableId, 'test-cable');
});

test('tracker.prune drops long-unseen sightings', () => {
  const tracker = new SightingTracker();
  tracker.observe(vessel(), { distM: 100, segment: { cableId: 'x', cableName: 'x', a: [0, 0], b: [1, 1] } }, Date.now() - 5 * 60 * 60_000);
  tracker.prune(Date.now());
  assert.equal(tracker.sightings.size, 0);
});

test('joinPass honest empty state: no vessels, no crash', () => {
  const index = buildCableIndex(CABLES);
  const tracker = new SightingTracker();
  const { candidates, threats } = joinPass([], index, tracker);
  assert.deepEqual([candidates.length, threats.length], [0, 0]);
});
