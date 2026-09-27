import assert from 'node:assert/strict';
import test from 'node:test';
import {
  pointInRing,
  tfrCentroid,
  flagFlightsInsideTfrs,
  crossTfrsWithFires,
  tfrColorFor,
} from './model.js';

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const TFR = {
  id: '6/5701',
  type: 'HAZARDS',
  state: 'OR',
  rings: [SQUARE],
  areas: [{ name: 'Hazard Area1', upperFt: 7500, lowerFt: 0 }],
};

test('pointInRing classifies inside/outside/edge', () => {
  assert.equal(pointInRing(5, 5, SQUARE), true);
  assert.equal(pointInRing(15, 5, SQUARE), false);
  assert.equal(pointInRing(-1, -1, SQUARE), false);
  assert.equal(pointInRing(5, 5, []), false);
});

test('tfrCentroid averages the first ring', () => {
  const c = tfrCentroid(TFR);
  assert.ok(Math.abs(c.lon - 4) < 1e-9 && Math.abs(c.lat - 4) < 1e-9);
  assert.equal(tfrCentroid({ rings: [] }), null);
  assert.equal(tfrCentroid(null), null);
});

test('flagFlightsInsideTfrs flags only aircraft inside geometry', () => {
  const aircraft = [
    { id: 'a1', lon: 5, lat: 5, altFt: 3000 },
    { id: 'a2', lon: 50, lat: 50, altFt: 3000 },
    { id: 'a3', lon: NaN, lat: 5, altFt: 1000 },
  ];
  const hits = flagFlightsInsideTfrs([TFR], aircraft);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].aircraft.id, 'a1');
  assert.equal(hits[0].tfr.id, '6/5701');
});

test('flagFlightsInsideTfrs never flags geometry-less TFRs', () => {
  const hits = flagFlightsInsideTfrs([{ id: '9/1', rings: [] }], [{ id: 'a', lon: 5, lat: 5 }]);
  assert.deepEqual(hits, []);
  assert.deepEqual(flagFlightsInsideTfrs(null, null), []);
});

test('crossTfrsWithFires matches overlapping bboxes only', () => {
  const perimeters = [
    { bbox: [4, 4, 6, 6], name: 'near' },
    { bbox: [100, 100, 110, 110], name: 'far' },
  ];
  const hits = crossTfrsWithFires([TFR], perimeters);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].perimeter.name, 'near');
  assert.deepEqual(crossTfrsWithFires([TFR], [{ bbox: [100, 100, 110, 110] }]), []);
  assert.deepEqual(crossTfrsWithFires([TFR], null), []);
});

test('tfrColorFor maps known types, defaults for unknown', () => {
  assert.equal(tfrColorFor('VIP'), '#ff4d6d');
  assert.equal(tfrColorFor('hazards'), '#ff9f1c');
  assert.equal(tfrColorFor('SPACE OPERATIONS'), '#9d4edd');
  assert.equal(tfrColorFor('mystery'), '#ff9f1c');
  assert.equal(tfrColorFor(null), '#ff9f1c');
});
