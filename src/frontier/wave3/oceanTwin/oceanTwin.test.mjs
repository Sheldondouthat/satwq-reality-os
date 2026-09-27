/**
 * oceanTwin model tests — real assertions over the bundled RTOFS snapshot
 * and the pure advection math. Seeded RNG keeps particle tests deterministic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  CURRENT_SNAPSHOT,
  PARTICLE_COUNT,
  PARTICLE_LIFETIME_H,
  buildSpatialIndex,
  sampleCurrent,
  createParticles,
  advectParticles,
  validateSnapshot,
  validatePoints,
  respawn,
} from './model.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Deterministic LCG. */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function loadSnapshot() {
  const doc = JSON.parse(
    await readFile(path.join(DIR, 'data', 'currents_snapshot.json'), 'utf8'),
  );
  return doc;
}

describe('oceanTwin model', () => {
  it('validates point sets and rejects garbage', () => {
    assert.deepEqual(validatePoints(null), { ok: false, reason: 'empty point set' });
    assert.equal(validatePoints([[0, 0, 0.1]]).ok, false);
    assert.equal(validatePoints([[91, 0, 0.1, 0.2]]).ok, false);
    assert.deepEqual(validatePoints([[10, -20, 0.1, -0.2]]), { ok: true, reason: null });
  });

  it('snapshot is present, valid, and ocean-scale', async () => {
    const doc = await loadSnapshot();
    const check = validateSnapshot(doc);
    assert.equal(check.ok, true, check.reason);
    assert.ok(doc.points.length > 5000, `points=${doc.points.length}`);
    assert.equal(doc.units, 'm/s');
    assert.match(doc.validTime, /2026-09-26/);
  });

  it('snapshot honesty metadata is explicit', () => {
    assert.match(CURRENT_SNAPSHOT.note, /Snapshot, not live/);
    assert.match(CURRENT_SNAPSHOT.source, /RTOFS/);
  });

  it('spatial index covers every point', async () => {
    const doc = await loadSnapshot();
    const spatial = buildSpatialIndex(doc.points);
    let covered = 0;
    for (const arr of spatial.index.values()) covered += arr.length;
    assert.equal(covered, doc.points.length);
  });

  it('samples the Gulf Stream region as an eastward flow (smeared by ~3° decimation)', async () => {
    const doc = await loadSnapshot();
    const spatial = buildSpatialIndex(doc.points);
    // Gulf Stream off Cape Hatteras: ~35N, ~72W. The narrow core is smeared
    // by decimation, so we assert direction + non-trivial speed, not core speed.
    const c = sampleCurrent(spatial, doc.points, 35, -72);
    assert.ok(c, 'expected current data near 35N 72W');
    assert.ok(c.u > 0.05, `expected eastward flow, got u=${c.u}`);
    assert.ok(Math.abs(c.v) < Math.abs(c.u) + 0.3, `expected zonal dominance, got v=${c.v}`);
  });

  it('returns null in data voids (mid-continent)', async () => {
    const doc = await loadSnapshot();
    const spatial = buildSpatialIndex(doc.points);
    const c = sampleCurrent(spatial, doc.points, 40, -100); // Kansas
    assert.equal(c, null);
  });

  it('advects particles down-current deterministically', async () => {
    const doc = await loadSnapshot();
    const spatial = buildSpatialIndex(doc.points);
    const rng = lcg(42);
    const ps = createParticles(doc.points, 200, rng);
    assert.equal(ps.length, 200);
    const before = ps.map((p) => [p.lat, p.lon]);
    const respawned = advectParticles(ps, spatial, doc.points, 24, rng);
    assert.ok(Number.isInteger(respawned) && respawned >= 0);
    let moved = 0;
    for (let i = 0; i < ps.length; i += 1) {
      if (Math.abs(ps[i].lat - before[i][0]) > 1e-9 || Math.abs(ps[i].lon - before[i][1]) > 1e-9) moved += 1;
      assert.ok(ps[i].lat >= -90 && ps[i].lat <= 90);
      assert.ok(ps[i].lon >= -180 && ps[i].lon <= 180);
    }
    assert.ok(moved > 50, `expected most particles to move, moved=${moved}`);
  });

  it('respawns aged-out particles within lifetime', async () => {
    const doc = await loadSnapshot();
    const spatial = buildSpatialIndex(doc.points);
    const rng = lcg(7);
    const ps = createParticles(doc.points, 50, rng);
    for (const p of ps) p.ageH = PARTICLE_LIFETIME_H + 1;
    const n = advectParticles(ps, spatial, doc.points, 1, rng);
    assert.equal(n, 50);
    for (const p of ps) assert.ok(p.ageH <= PARTICLE_LIFETIME_H);
  });

  it('respawn lands on a real snapshot point', async () => {
    const doc = await loadSnapshot();
    const rng = lcg(9);
    const p = { lat: 0, lon: 0, ageH: 0 };
    respawn(p, doc.points, rng);
    const match = doc.points.some((q) => q[0] === p.lat && q[1] === p.lon);
    assert.ok(match, 'respawned particle is not on a snapshot point');
  });

  it('particle count constant is sane', () => {
    assert.ok(PARTICLE_COUNT >= 500 && PARTICLE_COUNT <= 5000);
  });
});
