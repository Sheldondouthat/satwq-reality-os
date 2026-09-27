import assert from 'node:assert/strict';
import test from 'node:test';
import { flattenAshVolumes, crossAshWithAircraft, pointInRing } from './model.js';

const SQUARE = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const ADVISORY = {
  volcano: 'SANGAY',
  advisoryNumber: 2026259,
  issueTime: '2026-09-27T05:32:00Z',
  observation: {
    time: '2026-09-27T04:30:00Z',
    status: 'OBS VA CLD',
    volumes: [{ upperFl: 200, lowerFl: null, lowerGround: true, rings: [SQUARE] }],
  },
  forecasts: [
    { time: '2026-09-27T10:30:00Z', volumes: [{ upperFl: 200, lowerFl: null, lowerGround: true, rings: [SQUARE] }] },
  ],
};

test('flattenAshVolumes emits observation + forecast records', () => {
  const vols = flattenAshVolumes([ADVISORY]);
  assert.equal(vols.length, 2);
  assert.equal(vols[0].kind, 'observation');
  assert.equal(vols[1].kind, 'forecast');
  assert.equal(vols[0].volcano, 'SANGAY');
  assert.equal(vols[0].upperFt, 20000);
  assert.equal(vols[0].lowerFt, 0); // lowerGround → 0 ft
  assert.equal(vols[0].status, 'OBS VA CLD');
  assert.equal(vols[1].status, null);
  assert.deepEqual(flattenAshVolumes(null), []);
});

test('flattenAshVolumes skips advisories without volumes', () => {
  const vols = flattenAshVolumes([{ volcano: 'X', observation: null, forecasts: [] }]);
  assert.deepEqual(vols, []);
});

test('crossAshWithAircraft flags altitude-aware intersections', () => {
  const vols = flattenAshVolumes([ADVISORY]);
  const aircraft = [
    { id: 'in', lon: 5, lat: 5, altFt: 15000 }, // inside band GND–FL200
    { id: 'above', lon: 5, lat: 5, altFt: 30000 }, // above FL200
    { id: 'out', lon: 50, lat: 50, altFt: 5000 }, // outside polygon
    { id: 'noalt', lon: 5, lat: 5, altFt: null }, // horizontal match, alt unknown
  ];
  const hits = crossAshWithAircraft(vols, aircraft);
  const ids = hits.map((h) => h.aircraft.id);
  assert.ok(ids.includes('in'), 'in-band aircraft flagged');
  assert.ok(!ids.includes('above'), 'above-band aircraft not flagged');
  assert.ok(!ids.includes('out'), 'outside-polygon aircraft not flagged');
  assert.ok(ids.includes('noalt'), 'unknown-altitude horizontal match flagged');
  const noalt = hits.find((h) => h.aircraft.id === 'noalt');
  assert.equal(noalt.altUnknown, true);
  assert.equal(noalt.volume.volcano, 'SANGAY');
});

test('crossAshWithAircraft returns empty on missing inputs', () => {
  assert.deepEqual(crossAshWithAircraft(null, null), []);
  assert.deepEqual(crossAshWithAircraft(flattenAshVolumes([ADVISORY]), []), []);
});

test('pointInRing sanity', () => {
  assert.equal(pointInRing(5, 5, SQUARE), true);
  assert.equal(pointInRing(50, 50, SQUARE), false);
});
