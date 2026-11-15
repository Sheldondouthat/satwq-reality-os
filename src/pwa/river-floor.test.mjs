/**
 * River floor tests (pure, no DOM): the V5-0 record-cache constitution.
 *
 * The contract under test (Packaging Matrix row 3, §2): a cached river
 * record renders its age from the DATA's own timestamp on every path;
 * past max-age (3,600 s) it classifies STALE with the watcher-blind
 * flag set; a cached record can NEVER classify as live. Fabricated
 * payloads only — the live endpoint is not touched.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FLOOR_PACKAGE,
  MAX_AGE_SECONDS,
  buildRecord,
  validateRecord,
  ageSecondsAt,
  thresholdState,
  classifyRecord,
  formatAge,
} from '../../public/river-floor.js';

const T0 = Date.parse('2026-11-15T07:30:00Z'); // the reading's instant

/** Fabricated /api/usgs-water-glen-lyn payload for a reading at T0. */
function payload({ gageHeightFt = 2.94, dischargeCfs = 1390, generatedAtMs = T0 } = {}) {
  return {
    id: 'usgs-water-glen-lyn',
    generatedAt: new Date(generatedAtMs).toISOString(),
    stale: false,
    site: '03176500',
    name: 'NEW RIVER AT GLEN LYN, VA',
    dataTime: new Date(T0).toISOString(),
    ageSeconds: 0,
    maxAgeSeconds: 3600,
    gageHeightFt,
    dischargeCfs,
    approvalStatus: 'Provisional',
    thresholds: { cautionFt: 13, floodStageFt: 15 },
  };
}

test('buildRecord carries the data timestamp and provenance, not the fetch time', () => {
  const fetchedAt = T0 + 26 * 3600_000; // fetched a day later (a relayed record)
  const rec = buildRecord(payload(), fetchedAt);
  assert.ok(rec);
  assert.equal(rec.dataTime, new Date(T0).toISOString());
  assert.equal(rec.fetchedAt, new Date(fetchedAt).toISOString());
  assert.deepEqual(rec.floorPackage, { id: FLOOR_PACKAGE.id, version: FLOOR_PACKAGE.version });
  assert.equal(rec.gageHeightFt, 2.94);
  assert.equal(rec.dischargeCfs, 1390);
  assert.equal(rec.approvalStatus, 'Provisional');
  // Age derives from dataTime alone: at fetch instant the reading is already 26 h old.
  assert.equal(ageSecondsAt(rec, fetchedAt), 26 * 3600);
});

test('buildRecord refuses payloads that cannot honestly become records', () => {
  assert.equal(buildRecord(null, T0), null);
  assert.equal(buildRecord({ dataTime: 'not-a-time', gageHeightFt: 2.9 }, T0), null);
  assert.equal(buildRecord({ dataTime: new Date(T0).toISOString(), gageHeightFt: null, dischargeCfs: null }, T0), null);
});

test('fresh payload on a live link classifies LIVE with its age', () => {
  const rec = buildRecord(payload(), T0);
  const c = classifyRecord(rec, T0 + 120_000, { fromCache: false });
  assert.equal(c.ageSeconds, 120);
  assert.equal(c.freshness, 'live');
  assert.equal(c.blind, false);
  assert.equal(c.threshold, 'ok');
});

test('the same fresh record from cache classifies HELD — never LIVE', () => {
  const rec = buildRecord(payload(), T0);
  const c = classifyRecord(rec, T0 + 120_000, { fromCache: true });
  assert.equal(c.ageSeconds, 120);
  assert.equal(c.freshness, 'held');
  assert.equal(c.blind, false);
});

test('borderline: at max-age the record is still held; one second past, STALE + blind', () => {
  const rec = buildRecord(payload(), T0);
  const atMax = classifyRecord(rec, T0 + MAX_AGE_SECONDS * 1000, { fromCache: true });
  assert.equal(atMax.ageSeconds, MAX_AGE_SECONDS);
  assert.equal(atMax.freshness, 'held');
  assert.equal(atMax.blind, false);
  const past = classifyRecord(rec, T0 + (MAX_AGE_SECONDS + 1) * 1000, { fromCache: true });
  assert.equal(past.freshness, 'stale');
  assert.equal(past.blind, true, 'watcher-blind fires when the data crosses max-age');
});

test('the D-1 ghost: a 22 h old reading under a FRESH generatedAt reads STALE', () => {
  // generatedAt = now (fresh), fetchedAt = now (fresh) — only dataTime is old.
  const now = T0 + 22 * 3600_000;
  const rec = buildRecord(payload({ generatedAtMs: now }), now);
  const fromNetwork = classifyRecord(rec, now, { fromCache: false });
  assert.equal(fromNetwork.ageSeconds, 22 * 3600);
  assert.equal(fromNetwork.freshness, 'stale', 'even a just-fetched old reading cannot render live');
  assert.equal(fromNetwork.blind, true);
  const fromCache = classifyRecord(rec, now, { fromCache: true });
  assert.equal(fromCache.freshness, 'stale');
  assert.equal(fromCache.blind, true);
});

test('threshold state rides with the record: ok / caution / flood / unknown', () => {
  assert.equal(thresholdState(12.99), 'ok');
  assert.equal(thresholdState(13.0), 'caution');
  assert.equal(thresholdState(14.99), 'caution');
  assert.equal(thresholdState(15.0), 'flood');
  assert.equal(thresholdState(16.2), 'flood');
  assert.equal(thresholdState(null), 'unknown');
  // …and through classifyRecord, computed from the cached value with its age attached:
  const floodRec = buildRecord(payload({ gageHeightFt: 16.2 }), T0);
  const c = classifyRecord(floodRec, T0 + 26 * 3600_000, { fromCache: true });
  assert.equal(c.threshold, 'flood');
  assert.equal(c.ageSeconds, 26 * 3600, 'the flood verdict carries the age of the value it was computed from');
  assert.equal(c.freshness, 'stale');
});

test('validateRecord enforces the floor-package version', () => {
  const rec = buildRecord(payload(), T0);
  assert.equal(validateRecord(rec), rec);
  const foreign = { ...rec, floorPackage: { id: FLOOR_PACKAGE.id, version: 999 } };
  assert.equal(validateRecord(foreign), null, 'a foreign floor version is invalidated, not rendered');
  assert.equal(validateRecord(null), null);
  assert.equal(validateRecord({ ...rec, dataTime: 'junk' }), null);
});

test('formatAge renders compact, honest ages', () => {
  assert.equal(formatAge(45), '45 s');
  assert.equal(formatAge(120), '2 min');
  assert.equal(formatAge(750), '12 min');
  assert.equal(formatAge(3600), '1 h 00 min');
  assert.equal(formatAge(22 * 3600), '22 h 00 min');
  assert.equal(formatAge(90061), '1 d 1 h 01 min');
  assert.equal(formatAge(null), 'unknown age');
});
