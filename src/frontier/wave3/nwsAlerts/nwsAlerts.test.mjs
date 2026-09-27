import assert from 'node:assert/strict';
import test from 'node:test';
import {
  severityRank,
  colorForAlert,
  alertCentroid,
  alertBbox,
  crossAlertsWithPerimeters,
  filterAlerts,
  sortAlertsBySeverity,
  fetchNwsAlerts,
} from './model.js';

const TORNADO = {
  id: 'urn:oid:1',
  event: 'Tornado Warning',
  severity: 'Extreme',
  geometry: {
    type: 'Polygon',
    coordinates: [[[-75.0, 40.0], [-74.0, 40.0], [-74.0, 41.0], [-75.0, 41.0], [-75.0, 40.0]]],
  },
};

const SMALL_CRAFT = {
  id: 'urn:oid:2',
  event: 'Small Craft Advisory',
  severity: 'Minor',
  geometry: null,
};

test('severityRank orders Unknown < Minor < Moderate < Severe < Extreme', () => {
  assert.ok(severityRank('Unknown') < severityRank('Minor'));
  assert.ok(severityRank('Minor') < severityRank('Moderate'));
  assert.ok(severityRank('Moderate') < severityRank('Severe'));
  assert.ok(severityRank('Severe') < severityRank('Extreme'));
  assert.equal(severityRank('Bogus'), 0);
});

test('colorForAlert grades Extreme redder than Minor', () => {
  const extreme = colorForAlert(TORNADO);
  const minor = colorForAlert(SMALL_CRAFT);
  assert.ok(extreme.r > minor.r || extreme.g < minor.g);
  assert.equal(colorForAlert({}).r, colorForAlert({ severity: 'Unknown' }).r);
});

test('alertCentroid averages the first ring', () => {
  const c = alertCentroid(TORNADO);
  assert.ok(Math.abs(c.lon - -74.6) < 0.01);
  assert.ok(Math.abs(c.lat - 40.4) < 0.01);
  assert.equal(alertCentroid(SMALL_CRAFT), null);
});

test('alertBbox spans MultiPolygon coordinates', () => {
  const box = alertBbox({
    geometry: {
      type: 'MultiPolygon',
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 0]]],
        [[[10, 10], [11, 10], [11, 11], [10, 10]]],
      ],
    },
  });
  assert.deepEqual(box, { minLon: 0, minLat: 0, maxLon: 11, maxLat: 11 });
  assert.equal(alertBbox(SMALL_CRAFT), null);
});

test('crossAlertsWithPerimeters flags bbox overlap only', () => {
  const perimeters = [
    { bbox: [-74.5, 40.5, -74.2, 40.8] }, // overlaps tornado
    { bbox: [100, 100, 101, 101] }, // nowhere near
  ];
  const crossed = crossAlertsWithPerimeters([TORNADO, SMALL_CRAFT], perimeters);
  assert.equal(crossed.find((c) => c.alert.id === 'urn:oid:1').fireOverlap, true);
  assert.equal(crossed.find((c) => c.alert.id === 'urn:oid:2').fireOverlap, false);
});

test('crossAlertsWithPerimeters accepts GeoJSON perimeter features', () => {
  const crossed = crossAlertsWithPerimeters([TORNADO], [
    { geometry: { type: 'Polygon', coordinates: [[[-74.5, 40.5], [-74.2, 40.5], [-74.2, 40.8], [-74.5, 40.5]]] } },
  ]);
  assert.equal(crossed[0].fireOverlap, true);
});

test('crossAlertsWithPerimeters tolerates a missing perimeter feed', () => {
  const crossed = crossAlertsWithPerimeters([TORNADO], null);
  assert.equal(crossed[0].fireOverlap, false);
});

test('filterAlerts applies severity floor and event substring', () => {
  const alerts = [TORNADO, SMALL_CRAFT];
  assert.deepEqual(filterAlerts(alerts, { minSeverity: 'Moderate' }).map((a) => a.id), ['urn:oid:1']);
  assert.deepEqual(filterAlerts(alerts, { eventIncludes: 'craft' }).map((a) => a.id), ['urn:oid:2']);
});

test('sortAlertsBySeverity puts Extreme first', () => {
  const sorted = sortAlertsBySeverity([SMALL_CRAFT, TORNADO]);
  assert.equal(sorted[0].id, 'urn:oid:1');
});

test('fetchNwsAlerts returns parsed JSON on 200', async () => {
  const payload = { count: 1, alerts: [TORNADO] };
  const out = await fetchNwsAlerts({
    fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }),
  });
  assert.equal(out.count, 1);
});

test('fetchNwsAlerts throws with status on HTTP error (honest empty-state path)', async () => {
  await assert.rejects(
    () => fetchNwsAlerts({ fetchImpl: async () => new Response('x', { status: 503 }) }),
    (error) => error.status === 503,
  );
});
