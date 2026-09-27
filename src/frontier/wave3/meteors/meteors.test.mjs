/**
 * Wave 3 Track 2c / 2.14 — GMN meteor tests.
 * Row fixture mirrors the real traj_summary_latest_daily.txt layout
 * (semicolon-delimited, UTC "YYYY-MM-DD HH:MM:SS.ffffff", LatBeg/LonBeg/
 * LatEnd/LonEnd at 0-based fields 63/65/69/71).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseGmnUtc,
  normalizeGmnRow,
  parseGmnSummary,
} from '../../../../server/providers/wave3/gmn.js';
import {
  subsolarPoint,
  solarZenithDeg,
  isNightSide,
  filterNightSide,
  streakDeg,
} from './model.js';
import { createMeteorsSource } from './source.js';

function rowFixture(over = {}) {
  const f = new Array(86).fill('');
  f[0] = '20260925101453_a42p2';
  f[1] = '2461308.927003396675';
  f[2] = '2026-09-25 10:14:53.093473';
  f[59] = '66.70270';
  f[63] = '34.305060';
  f[65] = '-113.040936';
  f[69] = '34.241141';
  f[71] = '-112.953094';
  f[79] = '0.0042';
  Object.assign(f, over);
  return f;
}

test('parseGmnUtc parses GMN UTC timestamps as UTC (not local)', () => {
  const ms = parseGmnUtc('2026-09-25 10:14:53.093473');
  assert.equal(ms, Date.UTC(2026, 8, 25, 10, 14, 53, 93));
  assert.equal(parseGmnUtc('2026-09-25 10:14:53'), Date.UTC(2026, 8, 25, 10, 14, 53, 0));
  assert.equal(parseGmnUtc('garbage'), null);
});

test('normalizeGmnRow extracts the real trajectory fields', () => {
  const m = normalizeGmnRow(rowFixture());
  assert.equal(m.id, '20260925101453_a42p2');
  assert.equal(m.timeMs, Date.UTC(2026, 8, 25, 10, 14, 53, 93));
  assert.equal(m.latBeg, 34.3051);
  assert.equal(m.lonBeg, -113.0409);
  assert.equal(m.latEnd, 34.2411);
  assert.equal(m.lonEnd, -112.9531);
  assert.equal(m.vInitKmS, 66.7027);
  assert.equal(m.massKg, 0.0042);
});

test('normalizeGmnRow rejects bad rows', () => {
  assert.equal(normalizeGmnRow(rowFixture({ 63: '999' })), null); // lat out of range
  assert.equal(normalizeGmnRow(rowFixture({ 2: 'nope' })), null); // bad time
  assert.equal(normalizeGmnRow(['a', 'b']), null); // too short
});

test('parseGmnSummary skips comments/CRs, sorts newest first', () => {
  const text = [
    '# Summary generated on 2026-09-26 21:29:12 UTC\r',
    '#  Unique trajectory; Beginning ...\r',
    `\r${rowFixture().join(';')}\r`,
    rowFixture({ 0: 'older', 2: '2026-09-24 01:00:00.000000' }).join(';'),
    'junk;row',
  ].join('\n');
  const out = parseGmnSummary(text);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, '20260925101453_a42p2');
  assert.equal(out[1].id, 'older');
});

test('subsolarPoint is sane near the September equinox', () => {
  // 2026-09-25 10:14 UTC: declination near 0, subsolar lon ~ +24E.
  const sun = subsolarPoint(Date.UTC(2026, 8, 25, 10, 14, 53));
  assert.ok(Math.abs(sun.lat) < 6, `decl ${sun.lat}`);
  assert.ok(sun.lon > 5 && sun.lon < 45, `lon ${sun.lon}`);
  assert.ok(solarZenithDeg(sun.lon, sun.lat, Date.UTC(2026, 8, 25, 10, 14, 53)) < 1);
});

test('isNightSide separates day from night', () => {
  const t = Date.UTC(2026, 8, 25, 10, 14, 53);
  const sun = subsolarPoint(t);
  assert.equal(isNightSide(sun.lon, sun.lat, t), false);
  const anti = sun.lon > 0 ? sun.lon - 180 : sun.lon + 180;
  assert.equal(isNightSide(anti, -sun.lat, t), true);
});

test('filterNightSide keeps only dark-hemisphere events', () => {
  const t = Date.UTC(2026, 8, 25, 10, 14, 53);
  const sun = subsolarPoint(t);
  const day = { timeMs: t, latBeg: sun.lat, lonBeg: sun.lon, latEnd: sun.lat, lonEnd: sun.lon + 0.1 };
  const anti = sun.lon > 0 ? sun.lon - 180 : sun.lon + 180;
  const night = { timeMs: t, latBeg: -sun.lat, lonBeg: anti, latEnd: -sun.lat, lonEnd: anti + 0.1 };
  const out = filterNightSide([day, night]);
  assert.equal(out.length, 1);
  assert.equal(out[0], night);
  assert.ok(streakDeg(night) > 0);
});

test('createMeteorsSource validates the /api/meteors shape', async () => {
  const ok = createMeteorsSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ meteors: [] }) }),
  });
  assert.deepEqual((await ok.getSnapshot()).meteors, []);
  const bad = createMeteorsSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(() => bad.getSnapshot(), /meteors_bad_shape/);
});
