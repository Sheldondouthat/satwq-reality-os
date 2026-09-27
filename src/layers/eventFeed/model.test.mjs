/**
 * Tests for src/layers/eventFeed/model.js — correlation logic (F1),
 * sky-anomaly detection (F6), and parser edge cases.
 *
 * Pure fixtures only: no network, no Cesium, no DOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTrafficDensity,
  DENSITY_CELL_DEG,
  DENSITY_ELEVATED_MIN,
  detectSkyAlerts,
  haversineKm,
  incidentTypeLabel,
  normalizeOpenSkyState,
  normalizeQuakeFeature,
  normalizeStorm,
  polygonCentroid,
  skyAlertKindLabel,
  synthesizeIncidents,
} from './model.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** OpenSky state vector builder (array form), sane defaults, overrides last. */
function mkState(icao24, overrides = {}) {
  const base = {
    callsign: 'TEST123',
    lon: -84.4,
    lat: 33.65,
    baroAltM: 3000,
    onGround: false,
    speedMps: 120,
    headingDeg: 90,
    vertRateMps: 0,
    squawk: null,
  };
  const o = { ...base, ...overrides };
  return [
    icao24, // 0 icao24
    o.callsign, // 1 callsign
    'United States', // 2 origin_country
    1_700_000_000, // 3 time_position
    1_700_000_005, // 4 last_contact
    o.lon, // 5 longitude
    o.lat, // 6 latitude
    o.baroAltM, // 7 baro_altitude (m)
    o.onGround, // 8 on_ground
    o.speedMps, // 9 velocity (m/s)
    o.headingDeg, // 10 true_track
    o.vertRateMps, // 11 vertical_rate (m/s)
    null, // 12 sensors
    o.baroAltM, // 13 geo_altitude
    o.squawk, // 14 squawk
    false, // 15 spi
    0, // 16 position_source
  ];
}

function mkSnapshot(atMs, trackOverridesList) {
  return {
    atMs,
    tracks: trackOverridesList.map(([icao24, overrides]) =>
      normalizeOpenSkyState(mkState(icao24, overrides)),
    ),
  };
}

const smokePoly = (density, lon, lat) => ({
  density,
  ring: [
    [lon - 1, lat - 1],
    [lon + 1, lat - 1],
    [lon + 1, lat + 1],
    [lon - 1, lat + 1],
    [lon - 1, lat - 1],
  ],
});

const quake = (id, lat, lon, mag = 5.2) => ({ id, lat, lon, mag, place: 'Test region', depthKm: 10, timeMs: 1 });
const storm = (id, lat, lon) => ({
  id, lat, lon, name: 'TestStorm', classification: 'Hurricane', windKt: 100, advisoryNumber: '12A',
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

test('haversineKm: 1 degree of latitude is ~111.2 km', () => {
  const km = haversineKm(0, 0, 1, 0);
  assert.ok(Math.abs(km - 111.19) < 0.5, `got ${km}`);
});

test('haversineKm is symmetric and zero for identical points', () => {
  assert.equal(haversineKm(33, -84, 33, -84), 0);
  assert.equal(haversineKm(33, -84, 40, -74), haversineKm(40, -74, 33, -84));
});

test('polygonCentroid returns the square center and null for junk', () => {
  const c = polygonCentroid([[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]);
  assert.deepEqual({ lon: c.lon, lat: c.lat }, { lon: 1.6, lat: 1.6 });
  assert.equal(polygonCentroid([]), null);
  assert.equal(polygonCentroid([['x', 'y']]), null);
});

// ---------------------------------------------------------------------------
// Normalizers
// ---------------------------------------------------------------------------

test('normalizeOpenSkyState parses a full vector; rejects positionless rows', () => {
  const t = normalizeOpenSkyState(mkState('abc123', { squawk: '7700' }));
  assert.equal(t.icao24, 'abc123');
  assert.equal(t.callsign, 'TEST123');
  assert.equal(t.squawk, '7700');
  assert.equal(t.lat, 33.65);
  assert.equal(t.lon, -84.4);
  assert.equal(t.baroAltM, 3000);
  assert.equal(t.speedMps, 120);
  assert.equal(t.headingDeg, 90);
  assert.equal(t.vertRateMps, 0);
  assert.equal(t.onGround, false);

  // Missing latitude → null
  const bad = mkState('bad1');
  bad[6] = null;
  assert.equal(normalizeOpenSkyState(bad), null);
  // Out-of-range longitude → null
  const bad2 = mkState('bad2', { lon: 400 });
  assert.equal(normalizeOpenSkyState(bad2), null);
  // Non-array → null
  assert.equal(normalizeOpenSkyState(null), null);
  assert.equal(normalizeOpenSkyState({}), null);
});

test('normalizeOpenSkyState keeps only 4-digit squawks, else null', () => {
  assert.equal(normalizeOpenSkyState(mkState('a', { squawk: '7500' })).squawk, '7500');
  assert.equal(normalizeOpenSkyState(mkState('b', { squawk: '2000' })).squawk, '2000');
  assert.equal(normalizeOpenSkyState(mkState('c', { squawk: '77' })).squawk, null);
  assert.equal(normalizeOpenSkyState(mkState('d', { squawk: 'ABCD' })).squawk, null);
  assert.equal(normalizeOpenSkyState(mkState('e')).squawk, null);
});

test('normalizeQuakeFeature parses USGS features; rejects missing mag/coords', () => {
  const q = normalizeQuakeFeature({
    id: 'us123',
    properties: { mag: 5.2, place: '10km S of Testville', time: 1_700_000_000_000 },
    geometry: { coordinates: [-84.4, 33.65, 12.5] },
  });
  assert.equal(q.id, 'us123');
  assert.equal(q.mag, 5.2);
  assert.equal(q.lat, 33.65);
  assert.equal(q.depthKm, 12.5);
  assert.equal(q.timeMs, 1_700_000_000_000);

  const noMag = normalizeQuakeFeature({
    properties: { mag: null }, geometry: { coordinates: [0, 0, 5] },
  });
  assert.equal(noMag, null);
  const noGeom = normalizeQuakeFeature({ properties: { mag: 5 } });
  assert.equal(noGeom, null);
});

test('normalizeStorm parses parsed-NHC storms; rejects missing position', () => {
  const s = normalizeStorm({
    id: 'al092026',
    name: 'TestStorm',
    classification: 'Hurricane',
    position: { longitude: -70, latitude: 25 },
    windKt: 100,
    advisoryNumber: '12A',
  });
  assert.equal(s.id, 'al092026');
  assert.equal(s.lat, 25);
  assert.equal(s.lon, -70);
  assert.equal(normalizeStorm({ id: 'x' }), null);
  assert.equal(normalizeStorm(null), null);
});

// ---------------------------------------------------------------------------
// Density grid
// ---------------------------------------------------------------------------

test('buildTrafficDensity marks cells at/above the elevated threshold', () => {
  const tracks = [];
  for (let i = 0; i < DENSITY_ELEVATED_MIN; i++)
    tracks.push({ lat: 33.6 + i * 0.01, lon: -84.4, icao24: `a${i}` });
  const cells = buildTrafficDensity(tracks);
  assert.equal(cells.length, 1);
  assert.equal(cells[0].count, DENSITY_ELEVATED_MIN);
  // cell center is the 2° cell center
  assert.ok(Math.abs(cells[0].lat - (Math.floor(33.6 / DENSITY_CELL_DEG) + 0.5) * DENSITY_CELL_DEG) < 1e-9);

  // One below threshold → not elevated
  const few = tracks.slice(0, DENSITY_ELEVATED_MIN - 1);
  assert.equal(buildTrafficDensity(few).length, 0);

  // Scattered tracks → no elevated cells
  const scattered = [];
  for (let i = 0; i < 50; i++)
    scattered.push({ lat: -60 + i * 2.4, lon: -180 + i * 7.1, icao24: `s${i}` });
  assert.equal(buildTrafficDensity(scattered).length, 0);

  // Junk tracks are skipped, not fatal
  assert.deepEqual(buildTrafficDensity([null, {}, { lat: 'x', lon: 1 }]), []);
});

// ---------------------------------------------------------------------------
// F1 incident synthesis
// ---------------------------------------------------------------------------

test('synthesizeIncidents: smoke near dense traffic → Smoke × Traffic card', () => {
  const incidents = synthesizeIncidents({
    smokePolygons: [smokePoly('heavy', -84.4, 33.65)],
    quakes: [],
    storms: [],
    densityCells: [{ lat: 33.5, lon: -84.5, count: 25 }],
    nowMs: 1_700_000_000_000,
  });
  assert.equal(incidents.length, 1);
  const [inc] = incidents;
  assert.equal(inc.type, 'smoke-near-traffic');
  assert.deepEqual(inc.sources, ['hms-smoke', 'opensky']);
  assert.equal(inc.severity, 'high'); // heavy smoke
  assert.ok(inc.confidence >= 0 && inc.confidence <= 1);
  assert.ok(Number.isFinite(inc.lat) && Number.isFinite(inc.lon));
  assert.equal(inc.at, new Date(1_700_000_000_000).toISOString());
  assert.match(inc.id, /^smoke-traffic:/);
});

test('synthesizeIncidents: light smoke never creates incidents', () => {
  const incidents = synthesizeIncidents({
    smokePolygons: [smokePoly('light', -84.4, 33.65)],
    densityCells: [{ lat: 33.5, lon: -84.5, count: 25 }],
    nowMs: 1_700_000_000_000,
  });
  assert.equal(incidents.length, 0);
});

test('synthesizeIncidents: distant smoke and traffic do not correlate', () => {
  const incidents = synthesizeIncidents({
    smokePolygons: [smokePoly('heavy', -84.4, 33.65)],
    densityCells: [{ lat: 51.5, lon: -0.4, count: 60 }], // London
    nowMs: 1_700_000_000_000,
  });
  assert.equal(incidents.length, 0);
});

test('synthesizeIncidents: quake near smoke → compound card with 2 sources', () => {
  const incidents = synthesizeIncidents({
    smokePolygons: [smokePoly('moderate', -120.5, 38.5)],
    quakes: [quake('q1', 38.6, -120.4, 6.3)],
    nowMs: 1_700_000_000_000,
  });
  assert.equal(incidents.length, 1);
  const [inc] = incidents;
  assert.equal(inc.type, 'quake-near-smoke');
  assert.deepEqual(inc.sources, ['usgs-quakes', 'hms-smoke']);
  assert.equal(inc.severity, 'high'); // M6.3
  assert.match(inc.title, /M6\.3/);
});

test('synthesizeIncidents: quake near storm and storm near traffic', () => {
  const incidents = synthesizeIncidents({
    quakes: [quake('q2', 25.2, -70.2, 5.0)],
    storms: [storm('al092026', 25.0, -70.0)],
    densityCells: [{ lat: 25.1, lon: -69.9, count: 40 }],
    nowMs: 1_700_000_000_000,
  });
  const types = incidents.map((i) => i.type).sort();
  assert.deepEqual(types, ['quake-near-storm', 'storm-near-traffic']);
  const qs = incidents.find((i) => i.type === 'quake-near-storm');
  assert.deepEqual(qs.sources, ['usgs-quakes', 'nhc-storms']);
  assert.equal(qs.severity, 'low'); // M5.0
  const st = incidents.find((i) => i.type === 'storm-near-traffic');
  assert.deepEqual(st.sources, ['nhc-storms', 'opensky']);
});

test('synthesizeIncidents: empty inputs → no incidents; every incident has >=2 sources', () => {
  assert.deepEqual(synthesizeIncidents({ nowMs: 1 }), []);
  const incidents = synthesizeIncidents({
    smokePolygons: [smokePoly('heavy', 0, 0)],
    quakes: [quake('q', 0.1, 0.1, 7.0)],
    storms: [storm('al1', 0.2, 0.2)],
    densityCells: [{ lat: 0.3, lon: 0.3, count: 100 }],
    nowMs: 1_700_000_000_000,
  });
  assert.ok(incidents.length >= 3);
  for (const inc of incidents) {
    assert.ok(inc.sources.length >= 2, `incident ${inc.id} has <2 sources`);
    assert.ok(['low', 'moderate', 'high', 'critical'].includes(inc.severity));
    assert.ok(inc.confidence >= 0 && inc.confidence <= 1);
  }
  // sorted: higher severity first
  for (let i = 1; i < incidents.length; i++) {
    const order = { low: 0, moderate: 1, high: 2, critical: 3 };
    assert.ok(order[incidents[i - 1].severity] >= order[incidents[i].severity]);
  }
});

test('synthesizeIncidents: duplicate quake ids do not duplicate cards', () => {
  const incidents = synthesizeIncidents({
    smokePolygons: [smokePoly('moderate', -120.5, 38.5)],
    quakes: [quake('dup', 38.6, -120.4), quake('dup', 38.61, -120.41)],
    nowMs: 1_700_000_000_000,
  });
  assert.equal(incidents.filter((i) => i.type === 'quake-near-smoke').length, 1);
});

// ---------------------------------------------------------------------------
// F6 sky alerts
// ---------------------------------------------------------------------------

const T0 = 1_700_000_000_000;

test('detectSkyAlerts: exact emergency squawks are factual, not heuristic', () => {
  for (const [squawk, kind] of [['7500', 'squawk-7500'], ['7600', 'squawk-7600'], ['7700', 'squawk-7700']]) {
    const alerts = detectSkyAlerts(
      [mkSnapshot(T0, [[`e${squawk}`, { squawk }]])],
      { nowMs: T0 },
    );
    assert.equal(alerts.length, 1, `squawk ${squawk}`);
    const [a] = alerts;
    assert.equal(a.kind, kind);
    assert.equal(a.heuristic, false);
    assert.equal(a.confidence, 1);
    assert.equal(a.squawk, squawk);
    assert.match(a.id, new RegExp(`^squawk-${squawk}:`));
  }
});

test('detectSkyAlerts: ordinary squawks and empty windows produce nothing', () => {
  const alerts = detectSkyAlerts(
    [mkSnapshot(T0, [['n1', { squawk: '1200' }], ['n2', { squawk: '2000' }], ['n3', {}]])],
    { nowMs: T0 },
  );
  assert.equal(alerts.length, 0);
  assert.deepEqual(detectSkyAlerts([], { nowMs: T0 }), []);
  assert.deepEqual(detectSkyAlerts(null, { nowMs: T0 }), []);
});

test('detectSkyAlerts: v1 holding-pattern heuristic fires on a turning cluster', () => {
  // 4 snapshots, 60 s apart; aircraft circles a ~2 km box with big heading changes.
  const snaps = [0, 60, 120, 180].map((sec, i) =>
    mkSnapshot(T0 + sec * 1000, [
      [
        'hold1',
        {
          lat: 33.65 + [0.01, 0.01, -0.01, -0.01][i],
          lon: -84.4 + [0.01, -0.01, -0.01, 0.01][i],
          headingDeg: [0, 90, 180, 270][i],
          speedMps: 80,
          baroAltM: 3000,
          vertRateMps: 0,
        },
      ],
    ]),
  );
  const alerts = detectSkyAlerts(snaps, { nowMs: T0 + 180_000 });
  assert.equal(alerts.length, 1);
  const [a] = alerts;
  assert.equal(a.kind, 'holding-pattern');
  assert.equal(a.heuristic, true);
  assert.equal(a.confidence, 0.55);
  assert.match(a.detail, /Heuristic v1/);
});

test('detectSkyAlerts: straight-and-level flight is NOT a holding pattern', () => {
  const snaps = [0, 60, 120, 180].map((sec, i) =>
    mkSnapshot(T0 + sec * 1000, [
      ['cruise1', { lat: 33.65, lon: -84.4 + i * 0.05, headingDeg: 90, speedMps: 220, baroAltM: 10000, vertRateMps: 0 }],
    ]),
  );
  assert.equal(detectSkyAlerts(snaps, { nowMs: T0 + 180_000 }).length, 0);
});

test('detectSkyAlerts: fewer than 3 snapshots cannot trigger heuristics', () => {
  const snaps = [0, 60].map((sec, i) =>
    mkSnapshot(T0 + sec * 1000, [
      ['hold2', { lat: 33.65 + i * 0.01, lon: -84.4, headingDeg: i * 180, speedMps: 80, baroAltM: 3000, vertRateMps: 0 }],
    ]),
  );
  assert.equal(detectSkyAlerts(snaps, { nowMs: T0 + 60_000 }).length, 0);
});

test('detectSkyAlerts: v1 go-around heuristic fires near an airport', () => {
  // Near ATL (33.6407, -84.4277): descending then climbing, low altitude.
  const snaps = [0, 60, 120].map((sec, i) =>
    mkSnapshot(T0 + sec * 1000, [
      [
        'ga1',
        {
          lat: 33.65,
          lon: -84.42,
          headingDeg: 90,
          speedMps: 70,
          baroAltM: 500,
          vertRateMps: [-4, -2, 5][i],
        },
      ],
    ]),
  );
  const alerts = detectSkyAlerts(snaps, { nowMs: T0 + 120_000 });
  assert.equal(alerts.length, 1);
  const [a] = alerts;
  assert.equal(a.kind, 'go-around');
  assert.equal(a.heuristic, true);
  assert.equal(a.confidence, 0.5);
  assert.match(a.title, /ATL/);
  assert.match(a.detail, /Heuristic v1/);
});

test('detectSkyAlerts: descent→climb far from airports is NOT a go-around', () => {
  const snaps = [0, 60, 120].map((sec, i) =>
    mkSnapshot(T0 + sec * 1000, [
      ['ga2', { lat: 0, lon: -150, headingDeg: 90, speedMps: 70, baroAltM: 500, vertRateMps: [-4, -2, 5][i] }],
    ]),
  );
  assert.equal(detectSkyAlerts(snaps, { nowMs: T0 + 120_000 }).length, 0);
});

test('detectSkyAlerts: on-ground tracks never trigger heuristics', () => {
  const snaps = [0, 60, 120, 180].map((sec, i) =>
    mkSnapshot(T0 + sec * 1000, [
      ['gnd1', { onGround: true, baroAltM: 0, speedMps: 10, headingDeg: [0, 120, 240, 60][i], vertRateMps: 0 }],
    ]),
  );
  assert.equal(detectSkyAlerts(snaps, { nowMs: T0 + 180_000 }).length, 0);
});

test('detectSkyAlerts: exact squawks sort before heuristics', () => {
  const snaps = [0, 60, 120, 180].map((sec, i) =>
    mkSnapshot(T0 + sec * 1000, [
      ['e7700', { squawk: '7700' }],
      [
        'hold3',
        {
          lat: 40.7 + [0.01, 0.01, -0.01, -0.01][i],
          lon: -74 + [0.01, -0.01, -0.01, 0.01][i],
          headingDeg: [0, 90, 180, 270][i],
          speedMps: 80,
          baroAltM: 3000,
          vertRateMps: 0,
        },
      ],
    ]),
  );
  const alerts = detectSkyAlerts(snaps, { nowMs: T0 + 180_000 });
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].kind, 'squawk-7700');
  assert.equal(alerts[1].kind, 'holding-pattern');
});

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

test('labels are human-readable and fall back to the raw key', () => {
  assert.equal(incidentTypeLabel('smoke-near-traffic'), 'Smoke × Traffic');
  assert.equal(incidentTypeLabel('quake-near-smoke'), 'Quake × Smoke');
  assert.equal(incidentTypeLabel('mystery'), 'mystery');
  assert.equal(skyAlertKindLabel('squawk-7700'), 'Squawk 7700');
  assert.equal(skyAlertKindLabel('go-around'), 'Go-around?');
  assert.equal(skyAlertKindLabel('mystery'), 'mystery');
});
