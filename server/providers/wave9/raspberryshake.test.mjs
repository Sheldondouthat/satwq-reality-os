/**
 * Wave 9 — Raspberry Shake network inventory tests.
 *
 * Fixture: server/providers/wave9/fixtures/rs-station-am-excerpt.txt —
 * REAL bytes captured live 2026-10-02 from
 * https://data.raspberryshake.org/fdsnws/station/1/query?network=AM&level=station&format=text
 * (header + 99 real rows: all R0000/R4788/RBDCC/S9F83 epochs + 60 assorted).
 * Expected summary values were computed by an INDEPENDENT python3 statement
 * over the same bytes (see run notes), never invented.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseStationInventory,
  buildPayload,
  numOrNull,
  latOrNull,
  lonOrNull,
  haversineKm,
  _raspberryShakeInternals as internals,
} from './raspberryshake.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FIXTURE = readFileSync(
  join(ROOT, 'server', 'providers', 'wave9', 'fixtures', 'rs-station-am-excerpt.txt'),
  'utf8'
);
// Fixed "now" matching the independent python3 computation: 2026-10-02T23:47:00Z.
const NOW_MS = Date.parse('2026-10-02T23:47:00.000Z');

function doc() {
  return parseStationInventory(FIXTURE, NOW_MS);
}

test('rejects a non-inventory body (bad shape → 502 class)', () => {
  assert.throws(() => parseStationInventory('<html>nope</html>', NOW_MS), /rs_bad_inventory_shape/);
});

test('summary counts match the independent python3 computation', () => {
  const d = doc();
  assert.equal(d.summary.network, 'AM');
  assert.equal(d.summary.totalStations, 30);
  assert.equal(d.summary.active, 22);
  assert.equal(d.summary.dark, 8);
  assert.equal(d.summary.newWeek, 0);
  assert.equal(d.summary.retiredWeek, 0);
});

test('multi-epoch grouping: R0000 has 6 closed epochs, latest position kept', () => {
  const d = doc();
  const st = d.byCode.get('R0000');
  assert.equal(st.epochs.length, 6);
  assert.equal(st.open, false);
  assert.equal(st.lat, 37.4054054054054);
  assert.equal(st.lon, 27.423958263048196);
});

test('corrupt upstream epoch coords read null (R4788 GPS-glitch epoch)', () => {
  const d = doc();
  const st = d.byCode.get('R4788');
  assert.equal(st.epochs.length, 7);
  assert.equal(st.open, true); // last epoch has no EndTime
  const glitch = st.epochs.find((e) => e.startMs === Date.parse('2021-01-28T09:10:40.073'));
  assert.ok(glitch, 'glitch epoch present');
  assert.equal(glitch.lat, null); // 7932671.19… range-guarded
  assert.equal(glitch.lon, 19.906159104982308); // lon was fine
  // station-level coords come from the latest (valid) epoch
  assert.equal(st.lat, -18.675675675675677);
});

test('RBDCC: 11 epochs, open, corrupt middle epoch nulled', () => {
  const d = doc();
  const st = d.byCode.get('RBDCC');
  assert.equal(st.epochs.length, 11);
  assert.equal(st.open, true);
  const glitch = st.epochs.find((e) => e.lat == null);
  assert.ok(glitch, 'one epoch has nulled lat');
  assert.equal(st.lat, -18.63963963963964);
});

test('non-R code shapes accepted (S9F83, 21 epochs, open)', () => {
  const d = doc();
  const st = d.byCode.get('S9F83');
  assert.ok(st, 'S-prefixed code present');
  assert.equal(st.epochs.length, 21);
  assert.equal(st.open, true);
});

test('density: 18 cells, sums to the 22 active stations', () => {
  const d = doc();
  assert.equal(d.density.length, 18);
  assert.equal(d.density.reduce((a, c) => a + c.count, 0), 22);
  assert.ok(d.density[0].count >= d.density[1].count, 'sorted desc');
});

test('numOrNull/latOrNull/lonOrNull guards (Number("")===0 class)', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull('37.4'), 37.4);
  assert.equal(numOrNull('0'), 0); // real zero preserved
  assert.equal(latOrNull('7934917.162162162'), null);
  assert.equal(latOrNull('-18.67'), -18.67);
  assert.equal(lonOrNull('200'), null);
  assert.equal(lonOrNull('-78.68'), -78.68);
});

test('haversineKm sanity: DC to R0084 ≈ 657 km', () => {
  const km = haversineKm(38.9, -77.4, 39.0, -70.0);
  assert.ok(km > 600 && km < 700, `got ${km}`);
});

test('buildPayload default: summary + density + honesty block', () => {
  const { status, body } = buildPayload(doc(), {}, false);
  assert.equal(status, 200);
  assert.equal(body.summary.totalStations, 30);
  assert.equal(body.density.length, 18);
  assert.ok(body.honesty.registryNotRealtime.includes('NOT real-time'));
  assert.ok(body.honesty.activeDefinition.includes('no EndTime'));
  assert.ok(body.honesty.noEventCatalog.includes('404'));
  assert.ok(body.generatedAt);
});

test('?station=: detail for R0000; requestedNotFound for wellformed-unknown; 400 for malformed', () => {
  const d = doc();
  const ok = buildPayload(d, { station: 'R0000' }, false);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.stations[0].code, 'R0000');
  assert.equal(ok.body.stations[0].epochs, 6);
  assert.equal(ok.body.stations[0].open, false);

  const nf = buildPayload(d, { station: 'ZZZZZ' }, false);
  assert.equal(nf.status, 200);
  assert.equal(nf.body.requestedNotFound, true);

  for (const bad of ['r1234', 'R12', 'R123456', 'R-123', '']) {
    const r = buildPayload(d, { station: bad }, false);
    assert.equal(r.status, 400, `station=${bad} should 400`);
    assert.equal(r.body.error, 'rs_bad_station');
  }
});

test('?box=: US-east box yields 1 station; malformed box → 400', () => {
  const d = doc();
  const r = buildPayload(d, { box: '-80,35,-70,45' }, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 1);
  const s = r.body.stations[0];
  assert.ok(s.lon >= -80 && s.lon <= -70 && s.lat >= 35 && s.lat <= 45);
  for (const bad of ['-80,35', 'a,b,c,d', '-80,35,-70,999', '-70,35,-80,45']) {
    const b = buildPayload(d, { box: bad }, false);
    assert.equal(b.status, 400, `box=${bad} should 400`);
  }
});

test('?near=: nearest-to-DC is R0084, ascending order, n honored', () => {
  const d = doc();
  const r = buildPayload(d, { near: '38.9,-77.4', n: '3' }, false);
  assert.equal(r.status, 200);
  assert.equal(r.body.count, 3);
  assert.equal(r.body.stations[0].code, 'R0084');
  assert.ok(Math.abs(r.body.stations[0].distKm - 657.1) < 1, `distKm=${r.body.stations[0].distKm}`);
  for (let i = 1; i < r.body.stations.length; i++) {
    assert.ok(r.body.stations[i].distKm >= r.body.stations[i - 1].distKm, 'ascending');
  }
  const bad = buildPayload(d, { near: '38.9' }, false);
  assert.equal(bad.status, 400);
});

test('internals exported for the proxy (pattern check)', () => {
  assert.equal(typeof internals.parseStationInventory, 'function');
  assert.equal(typeof internals.buildPayload, 'function');
  assert.equal(typeof internals.resetCache, 'function');
  assert.match(internals.UPSTREAM_URL, /^https:\/\/data\.raspberryshake\.org/);
});
