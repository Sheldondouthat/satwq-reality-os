import assert from 'node:assert/strict';
import test from 'node:test';
import {
  julianDay,
  subsolarPoint,
  solarElevation,
  solarDeclination,
  terminatorLine,
  onTerminatorBand,
  bandMembership,
  TERMINATOR_CENTER_ELEV,
  TERMINATOR_HALF_WIDTH,
} from './solar.js';
import { normalizeEvent, eventsOnBand, fetchBandEvents } from './model.js';

const EQUINOX_NOON = new Date(Date.UTC(2026, 8, 22, 12, 0, 0));

test('subsolar point at equinox noon UTC is near (0°, 0°)', () => {
  const sub = subsolarPoint(EQUINOX_NOON);
  assert.ok(Math.abs(sub.lat) < 1.0, `lat ${sub.lat}`);
  assert.ok(Math.abs(sub.lon) < 3.0, `lon ${sub.lon}`);
});

test('solar declination near zero at equinox, ±23.4° at solstices', () => {
  const eq = solarDeclination(EQUINOX_NOON) * (180 / Math.PI);
  assert.ok(Math.abs(eq) < 1.0, `equinox decl ${eq}`);
  const june = solarDeclination(new Date(Date.UTC(2026, 5, 21, 12, 0, 0))) * (180 / Math.PI);
  assert.ok(june > 23.0 && june < 23.9, `june decl ${june}`);
  const dec = solarDeclination(new Date(Date.UTC(2026, 11, 21, 12, 0, 0))) * (180 / Math.PI);
  assert.ok(dec < -23.0 && dec > -23.9, `dec decl ${dec}`);
});

test('solarElevation is 90° at the subsolar point, −90° at the antipode', () => {
  const sub = subsolarPoint(EQUINOX_NOON);
  assert.ok(Math.abs(solarElevation(sub.lat, sub.lon, EQUINOX_NOON) - 90) < 0.01);
  assert.ok(Math.abs(solarElevation(-sub.lat, sub.lon + 180, EQUINOX_NOON) + 90) < 0.01);
});

test('solarElevation at London, equinox noon ≈ 90 − 51.5 + decl', () => {
  const elev = solarElevation(51.5, 0, EQUINOX_NOON);
  assert.ok(Math.abs(elev - 39.1) < 1.0, `got ${elev}`);
});

test('julianDay matches a known value (2026-09-27 00:00 UTC ≈ 2461310.5)', () => {
  const jd = julianDay(new Date(Date.UTC(2026, 8, 27, 0, 0, 0)));
  assert.ok(Math.abs(jd - 2461310.5) < 0.01, `got ${jd}`);
});

test('terminatorLine points all sit on the target elevation', () => {
  const now = new Date();
  for (const target of [-4, -6, -8]) {
    const line = terminatorLine(now, target, 90);
    assert.ok(line.length > 40, `only ${line.length} points at ${target}°`);
    for (const p of line) {
      const err = Math.abs(solarElevation(p.lat, p.lon, now) - target);
      assert.ok(err < 0.05, `point off by ${err}°`);
    }
  }
});

test('terminatorLine forms a closed loop (first/last adjacent)', () => {
  const line = terminatorLine(new Date(), -6, 90);
  const f = line[0];
  const l = line[line.length - 1];
  // Longitude wraps at the ±180 antimeridian: 176 and −180 are 4° apart,
  // not 356°. The naive hypot() misreads a seam-crossing closure as a gap
  // (OBSERVED 2026-09-28: first=(176,−82.3), last=(−180,−82.28) → 356).
  const dLon = Math.abs(f.lon - l.lon);
  const wrappedDLon = Math.min(dLon, 360 - dLon);
  assert.ok(Math.hypot(wrappedDLon, f.lat - l.lat) < 6, 'loop does not close');
});

test('onTerminatorBand brackets −6° ± 2°', () => {
  assert.equal(onTerminatorBand(-6), true);
  assert.equal(onTerminatorBand(-4), true);
  assert.equal(onTerminatorBand(-8), true);
  assert.equal(onTerminatorBand(-3.9), false);
  assert.equal(onTerminatorBand(0), false);
  assert.equal(onTerminatorBand(-10), false);
});

test('bandMembership returns elevation and band flag', () => {
  const sub = subsolarPoint(EQUINOX_NOON);
  const day = bandMembership(sub.lat, sub.lon, EQUINOX_NOON);
  assert.equal(day.onBand, false);
  assert.ok(day.elevation > 80);
});

test('normalizeEvent accepts lat/lon, latitude/longitude, and GeoJSON', () => {
  assert.deepEqual(
    { lat: normalizeEvent({ lat: 1, lon: 2 }).lat, lon: normalizeEvent({ lat: 1, lon: 2 }).lon },
    { lat: 1, lon: 2 },
  );
  const g = normalizeEvent({ geometry: { type: 'Point', coordinates: [3, 4] } });
  assert.deepEqual([g.lat, g.lon], [4, 3]);
  assert.equal(normalizeEvent({ lat: 'x', lon: 2 }), null);
  assert.equal(normalizeEvent(null), null);
});

test('eventsOnBand keeps only events on the band, capped', () => {
  const now = new Date();
  const sub = subsolarPoint(now);
  // Antisolar point is deep night (off band); terminator line point is on band.
  const line = terminatorLine(now, -6, 90);
  const onBand = eventsOnBand(
    [
      { lat: line[0].lat, lon: line[0].lon, label: 'dusk fire', kind: 'fire' },
      { lat: -sub.lat, lon: ((sub.lon + 180 + 540) % 360) - 180, label: 'midnight', kind: 'fire' },
    ],
    now,
  );
  assert.equal(onBand.length, 1);
  assert.equal(onBand[0].label, 'dusk fire');
  assert.ok(Number.isFinite(onBand[0].solarElevation));
});

test('fetchBandEvents degrades per-feed, never throws', async () => {
  const { events, degradedSources } = await fetchBandEvents({
    fetchImpl: async (url) => {
      if (url === '/api/firms') {
        return new Response(JSON.stringify({ fires: [{ lat: 40, lon: -75, confidence: 'h' }] }), { status: 200 });
      }
      return new Response('down', { status: 503 });
    },
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'fire');
  assert.equal(degradedSources.length, 3);
  assert.ok(degradedSources.every((d) => d.reason));
});
