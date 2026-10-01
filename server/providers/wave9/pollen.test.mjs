/**
 * Wave 9 (R2-8) — pollen provider tests (co-located).
 *
 * Fixtures are REAL upstream bytes captured live 2026-09-30 from
 * https://air-quality-api.open-meteo.com/v1/air-quality (Berlin, first 24h
 * of the 72h CAMS pollen series, timezone Europe/Berlin). The all-null US
 * shape mirrors the live Pembroke VA response (all 6 types null, 72/72h).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseQuery,
  parseLocationPayload,
  buildPayload,
  buildUpstreamUrl,
  selectionPlaces,
  numOrNull,
  roundOrNull,
  POLLEN_TYPES,
  LOCATIONS,
  _pollenInternals,
} from './pollen.js';

// Real Berlin bytes (trimmed to 24h for the fixture), live 2026-09-30.
const BERLIN_FIXTURE = {"latitude":52.5,"longitude":13.400002,"timezone":"Europe/Berlin","hourly_units":{"time":"iso8601","alder_pollen":"grains/m³","birch_pollen":"grains/m³","grass_pollen":"grains/m³","mugwort_pollen":"grains/m³","olive_pollen":"grains/m³","ragweed_pollen":"grains/m³"},"hourly":{"time":["2026-10-01T00:00","2026-10-01T01:00","2026-10-01T02:00","2026-10-01T03:00","2026-10-01T04:00","2026-10-01T05:00","2026-10-01T06:00","2026-10-01T07:00","2026-10-01T08:00","2026-10-01T09:00","2026-10-01T10:00","2026-10-01T11:00","2026-10-01T12:00","2026-10-01T13:00","2026-10-01T14:00","2026-10-01T15:00","2026-10-01T16:00","2026-10-01T17:00","2026-10-01T18:00","2026-10-01T19:00","2026-10-01T20:00","2026-10-01T21:00","2026-10-01T22:00","2026-10-01T23:00"],"alder_pollen":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0],"birch_pollen":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0],"grass_pollen":[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.0,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1],"mugwort_pollen":[0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.2,0.2,0.2,0.2,0.2,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.1,0.0],"olive_pollen":[0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0],"ragweed_pollen":[0.2,0.3,0.4,0.5,0.5,0.5,0.5,0.5,0.5,0.4,0.4,0.3,0.3,0.3,0.2,0.2,0.2,0.2,0.2,0.2,0.2,0.1,0.1,0.1]}};

const BERLIN = LOCATIONS.find((l) => l.id === 'berlin');

test('numOrNull guards the Number(null)/Number("")===0 trap', () => {
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull(undefined), null);
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull('   '), null);
  assert.equal(numOrNull('abc'), null);
  assert.equal(numOrNull(0), 0); // real model zero is preserved, not nulled
  assert.equal(numOrNull('0.1'), 0.1);
  assert.equal(roundOrNull(null), null);
  assert.equal(roundOrNull(0.126), 0.13);
});

test('parseLocationPayload on real Berlin bytes', () => {
  const row = parseLocationPayload(BERLIN_FIXTURE, BERLIN);
  assert.equal(row.ok, true);
  assert.equal(row.id, 'berlin');
  assert.equal(row.coverage, 'cams-europe');
  assert.equal(row.dataHours, 24);
  assert.equal(row.timezone, 'Europe/Berlin');
  assert.equal(row.gridLat, 52.5);
  // current = first hour with any non-null (hour 0 has all six present)
  assert.equal(row.currentTime, '2026-10-01T00:00');
  assert.deepEqual(row.current, { alder: 0, birch: 0, grass: 0.1, mugwort: 0.1, olive: 0, ragweed: 0.2 });
  // daily maxima over the local calendar day
  assert.equal(row.dailyMax.length, 1);
  assert.equal(row.dailyMax[0].date, '2026-10-01');
  assert.equal(row.dailyMax[0].ragweed, 0.5);
  assert.equal(row.dailyMax[0].mugwort, 0.2);
  assert.equal(row.dailyMax[0].grass, 0.1);
  assert.equal(row.nonNullValues, 24 * 6);
});

test('parseLocationPayload classifies all-null US shape as outside-cams-pollen-domain', () => {
  // Mirrors the live Pembroke VA response 2026-09-30: keys present, all nulls.
  const us = JSON.parse(JSON.stringify(BERLIN_FIXTURE));
  for (const t of POLLEN_TYPES) us.hourly[`${t}_pollen`] = us.hourly[`${t}_pollen`].map(() => null);
  const row = parseLocationPayload(us, { id: 'pt-37.27--80.73', name: 'Custom point', country: null, lat: 37.27, lon: -80.73 });
  assert.equal(row.ok, true);
  assert.equal(row.coverage, 'outside-cams-pollen-domain');
  assert.equal(row.current, null); // never synthesized from nulls
  assert.equal(row.currentTime, null);
  assert.equal(row.dailyMax.length, 1);
  assert.equal(row.dailyMax[0].ragweed, null); // nulls preserved, never zero-filled
});

test('parseLocationPayload throws 502 on bad shapes, never fabricates', () => {
  assert.throws(() => parseLocationPayload({}, BERLIN), /pollen_invalid_payload/);
  assert.throws(() => parseLocationPayload({ hourly: { time: [] } }, BERLIN), /empty hourly/);
  const short = JSON.parse(JSON.stringify(BERLIN_FIXTURE));
  short.hourly.grass_pollen.pop();
  assert.throws(() => parseLocationPayload(short, BERLIN), /bad series grass_pollen/);
  try {
    parseLocationPayload({ hourly: { time: ['x'] } }, BERLIN);
    assert.fail('should have thrown');
  } catch (e) {
    assert.equal(e.status, 502);
  }
});

test('parseQuery modes and validation', () => {
  const q = (s) => parseQuery(new URL(`http://x/?${s}`).searchParams);
  assert.deepEqual(q(''), { mode: 'all' });
  const city = q('city=paris');
  assert.equal(city.mode, 'city');
  assert.equal(city.city.id, 'paris');
  assert.deepEqual(q('city=london999'), { mode: 'notfound', city: 'london999' });
  assert.throws(() => q('city=!!!'), /pollen_bad_city/);
  const pt = q('lat=48.8&lon=2.3');
  assert.equal(pt.mode, 'point');
  assert.equal(pt.lat, 48.8);
  assert.equal(pt.lon, 2.3);
  assert.throws(() => q('lat=abc&lon=2'), /pollen_bad_lat/);
  assert.throws(() => q('lat=48&lon='), /pollen_bad_lon/); // Number('')===0 trap
  assert.throws(() => q('lat=95&lon=2'), /pollen_bad_lat/);
  assert.throws(() => q('lat=48&lon=200'), /pollen_bad_lon/);
});

test('buildUpstreamUrl pins the six CAMS pollen fields', () => {
  const url = buildUpstreamUrl({ lat: 52.52, lon: 13.41 });
  assert.ok(url.startsWith('https://air-quality-api.open-meteo.com/v1/air-quality?'));
  const p = new URL(url).searchParams;
  assert.equal(p.get('hourly'), 'alder_pollen,birch_pollen,grass_pollen,mugwort_pollen,olive_pollen,ragweed_pollen');
  assert.equal(p.get('forecast_days'), '3');
  assert.equal(p.get('timezone'), 'auto');
});

test('selectionPlaces honors city/point/all', () => {
  assert.equal(selectionPlaces({ mode: 'all' }).length, 8);
  assert.deepEqual(selectionPlaces({ mode: 'city', city: BERLIN }).map((p) => p.id), ['berlin']);
  const pt = selectionPlaces({ mode: 'point', lat: 37.27, lon: -80.73 });
  assert.equal(pt.length, 1);
  assert.equal(pt[0].lat, 37.27);
});

test('buildPayload carries the mandatory CAMS-model honesty block', () => {
  const rows = [parseLocationPayload(BERLIN_FIXTURE, BERLIN)];
  const payload = buildPayload(rows, false);
  assert.equal(payload.model, true);
  assert.match(payload.modelName, /CAMS/);
  assert.match(payload.warning, /not sensor observations/);
  assert.deepEqual(payload.types, POLLEN_TYPES);
  assert.equal(payload.units, 'grains/m³');
  assert.equal(payload.locations.length, 1);
  assert.equal(payload.stale, false);
  assert.match(payload.attribution, /Open-Meteo/);
});

test('clearCaches is safe to call (no leaked state between runs)', () => {
  _pollenInternals.clearCaches();
  assert.ok(true);
});
