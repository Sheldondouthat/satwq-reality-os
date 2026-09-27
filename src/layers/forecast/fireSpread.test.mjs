import assert from 'node:assert/strict';
import test from 'node:test';
import {
  projectSpread,
  headRateOfSpreadKmh,
  normalizeIgnition,
  normalizeWind,
  ringsToFeatureCollection,
  DEFAULT_WIND,
  SPREAD_HOURS_DEFAULT,
} from './fireSpread.js';

const IGNITION = { lat: 40.0, lon: -121.0, label: 'Test fire', source: 'fixture' };
const WIND = { fromDeg: 270, speedKmh: 20, label: 'fixture wind', measured: true };
const HOURS = [6, 12, 24];

test('projectSpread emits one closed valid ring per ignition per hour', () => {
  const { rings, skipped } = projectSpread({
    ignitions: [IGNITION, IGNITION],
    wind: WIND,
    hours: HOURS,
  });
  assert.equal(skipped, 0);
  assert.equal(rings.length, 2 * HOURS.length);
  for (const ring of rings) {
    assert.ok(HOURS.includes(ring.hour));
    const [first, ...rest] = ring.polygon;
    const last = rest.at(-1);
    assert.deepEqual(first, last, 'ring must be closed');
    for (const [lon, lat] of ring.polygon) {
      assert.ok(Number.isFinite(lon) && Number.isFinite(lat));
      assert.ok(Math.abs(lat) <= 90 && Math.abs(lon) <= 180);
    }
    assert.equal(ring.modeled, true, 'every ring is labeled modeled');
    assert.equal(ring.ignition.label, 'Test fire');
  }
});

test('spread grows with hours: head run and area are monotone', () => {
  const { rings } = projectSpread({ ignitions: [IGNITION], wind: WIND, hours: HOURS });
  const areas = rings.map((r) => r.areaKm2);
  const heads = rings.map((r) => r.headRunKm);
  for (let i = 1; i < rings.length; i++) {
    assert.ok(areas[i] > areas[i - 1], `area grows: ${areas}`);
    assert.ok(heads[i] > heads[i - 1], `head run grows: ${heads}`);
  }
});

test('downwind bias: centroid is displaced toward the downwind bearing', () => {
  // Wind FROM west (270) => fire travels toward east (90).
  const { rings } = projectSpread({
    ignitions: [IGNITION],
    wind: { fromDeg: 270, speedKmh: 25 },
    hours: [12],
  });
  const [ring] = rings;
  assert.equal(ring.downwindBearingDeg, 90);
  // Ignition at lon -121; downwind centroid must be EAST of the ignition.
  assert.ok(
    ring.centroid.lon > IGNITION.lon,
    `centroid ${ring.centroid.lon} should be east of ignition ${IGNITION.lon}`,
  );
  assert.ok(
    Math.abs(ring.centroid.lat - IGNITION.lat) < 0.5,
    'crosswind drift stays small',
  );
});

test('wind FROM north spreads southward; calm wind still spreads', () => {
  const { rings } = projectSpread({
    ignitions: [IGNITION],
    wind: { fromDeg: 0, speedKmh: 10 },
    hours: [6],
  });
  assert.equal(rings[0].downwindBearingDeg, 180);
  assert.ok(rings[0].centroid.lat < IGNITION.lat, 'centroid south of ignition');

  const calm = projectSpread({
    ignitions: [IGNITION],
    wind: { fromDeg: 90, speedKmh: 0 },
    hours: [6],
  });
  assert.ok(calm.rings[0].areaKm2 > 0, 'zero wind still yields a small ring');
});

test('stronger wind -> larger head run and narrower aspect', () => {
  const gentle = projectSpread({
    ignitions: [IGNITION],
    wind: { fromDeg: 270, speedKmh: 5 },
    hours: [12],
  }).rings[0];
  const strong = projectSpread({
    ignitions: [IGNITION],
    wind: { fromDeg: 270, speedKmh: 60 },
    hours: [12],
  }).rings[0];
  assert.ok(strong.headRunKm > gentle.headRunKm);
  assert.ok(strong.areaKm2 > gentle.areaKm2);
});

test('invalid ignitions are skipped and counted, not thrown', () => {
  const { rings, skipped } = projectSpread({
    ignitions: [IGNITION, null, { lat: 999, lon: 0 }, { lat: 'x', lon: 0 }],
    wind: WIND,
    hours: [6],
  });
  assert.equal(rings.length, 1);
  assert.equal(skipped, 3);
});

test('normalizeWind falls back honestly to the labeled default', () => {
  const w = normalizeWind({});
  assert.equal(w.fromDeg, DEFAULT_WIND.fromDeg);
  assert.equal(w.speedKmh, DEFAULT_WIND.speedKmh);
  assert.ok(w.label.includes('Assumed wind'), 'default carries the honest label');
  assert.equal(w.measured, false);
  const measured = normalizeWind({ fromDeg: 45, speedKmh: 12, measured: true, label: 'GRIB' });
  assert.equal(measured.measured, true);
  assert.equal(measured.label, 'GRIB');
});

test('normalizeIgnition rejects garbage coordinates', () => {
  assert.equal(normalizeIgnition(null), null);
  assert.equal(normalizeIgnition({ lat: 91, lon: 0 }), null);
  assert.equal(normalizeIgnition({ lat: 0, lon: 181 }), null);
  assert.deepEqual(normalizeIgnition({ lat: 40, lon: -121 }).label, null);
});

test('headRateOfSpreadKmh is bounded and grows with wind', () => {
  assert.ok(headRateOfSpreadKmh(60) > headRateOfSpreadKmh(5));
  assert.ok(headRateOfSpreadKmh(-10) >= 0.2, 'negative wind clamps');
  assert.ok(headRateOfSpreadKmh(1000) <= 15, 'extreme wind caps');
});

test('ringsToFeatureCollection filters by hour and marks modeled', () => {
  const { rings } = projectSpread({ ignitions: [IGNITION], wind: WIND, hours: HOURS });
  const fc = ringsToFeatureCollection(rings, 12);
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, 1);
  assert.equal(fc.features[0].geometry.type, 'Polygon');
  assert.equal(fc.features[0].properties.modeled, true);
  assert.equal(fc.features[0].properties.hour, 12);
});

test('SPREAD_HOURS_DEFAULT is [6,12,24] and hours normalize', () => {
  assert.deepEqual([...SPREAD_HOURS_DEFAULT], [6, 12, 24]);
  const { rings } = projectSpread({ ignitions: [IGNITION], wind: WIND });
  assert.deepEqual(rings.map((r) => r.hour), [6, 12, 24]);
});
