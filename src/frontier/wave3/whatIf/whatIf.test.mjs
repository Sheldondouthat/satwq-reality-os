/**
 * whatIf physics tests — real assertions against published reference values.
 *
 * Reference anchors (hand-computed, documented below):
 *  - 1 Mt surface burst → cube-root scaled Glasstone radii: 1 kt cbrt=10,
 *    so r20=2.8km, r5=6.2km, r1=16.0km at 1000 kt.
 *  - Chelyabinsk-class: d=20m, rho=3000, v=19 km/s → E ≈ 0.46 Mt.
 *  - Tsunami speed at 4000 m: sqrt(9.80665*4000)*3.6 ≈ 712.9 km/h.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  WHATIF_HONESTY,
  impactEnergyMt,
  craterDiameterKm,
  overpressureRadiiKm,
  thermalRadiusKm,
  tsunamiSpeedKmh,
  tsunamiArrivalRings,
  simulateAsteroid,
  simulateBurst,
  simulateTsunami,
  destinationPoint,
  ringPolygon,
} from './model.js';

describe('whatIf physics', () => {
  it('computes Chelyabinsk-class energy (~0.46 Mt)', () => {
    const E = impactEnergyMt({ diameterM: 20, densityKgM3: 3000, velocityKmS: 19 });
    assert.ok(Math.abs(E - 0.46) < 0.1, `E=${E} Mt`);
  });

  it('scales energy with diameter^3 (10x diameter = 1000x energy)', () => {
    const a = impactEnergyMt({ diameterM: 10, densityKgM3: 3000, velocityKmS: 20 });
    const b = impactEnergyMt({ diameterM: 100, densityKgM3: 3000, velocityKmS: 20 });
    assert.ok(Math.abs(b / a - 1000) < 1, `ratio=${b / a}`);
  });

  it('rejects non-physical inputs', () => {
    assert.throws(() => impactEnergyMt({ diameterM: 0, densityKgM3: 3000, velocityKmS: 20 }), TypeError);
    assert.throws(() => impactEnergyMt({ diameterM: -5, densityKgM3: 3000, velocityKmS: 20 }), TypeError);
    assert.throws(() => overpressureRadiiKm(Number.NaN), TypeError);
  });

  it('matches Glasstone cube-root radii for 1 Mt', () => {
    const r = overpressureRadiiKm(1000);
    assert.ok(Math.abs(r.r20psiKm - 2.8) < 0.05, `r20=${r.r20psiKm}`);
    assert.ok(Math.abs(r.r5psiKm - 6.2) < 0.05, `r5=${r.r5psiKm}`);
    assert.ok(Math.abs(r.r1psiKm - 16.0) < 0.1, `r1=${r.r1psiKm}`);
  });

  it('scales overpressure radii with cube root of yield', () => {
    const a = overpressureRadiiKm(1);
    const b = overpressureRadiiKm(1000);
    assert.ok(Math.abs(b.r1psiKm / a.r1psiKm - 10) < 0.01);
  });

  it('thermal radius crosses the 1-psi ring with yield (known Glasstone crossover)', () => {
    // At small yields blast outranges burns; at megaton yields thermal dominates.
    const small = { th: thermalRadiusKm(1), r1: overpressureRadiiKm(1).r1psiKm };
    const big = { th: thermalRadiusKm(1000), r1: overpressureRadiiKm(1000).r1psiKm };
    assert.ok(small.th < small.r1, `1kt: thermal=${small.th} vs r1=${small.r1}`);
    assert.ok(big.th > big.r1, `1Mt: thermal=${big.th} vs r1=${big.r1}`);
    // sub-linear growth: 1000x yield → 1000^0.41 ≈ 17x radius, not 1000x
    assert.ok(Math.abs(big.th / thermalRadiusKm(1) - 1000 ** 0.41) < 0.01);
  });

  it('tsunami speed ≈ 713 km/h at 4000 m depth', () => {
    const v = tsunamiSpeedKmh(4000);
    assert.ok(Math.abs(v - 712.9) < 0.5, `v=${v}`);
  });

  it('tsunami rings grow linearly with time', () => {
    const rings = tsunamiArrivalRings([1, 2, 4]);
    assert.equal(rings.length, 3);
    assert.ok(Math.abs(rings[2].radiusKm - 2 * rings[1].radiusKm) < 0.01);
    assert.ok(Math.abs(rings[0].radiusKm - 712.9) < 0.5);
  });

  it('asteroid scenario is internally consistent', () => {
    const r = simulateAsteroid({ diameterM: 100, densityKgM3: 3000, velocityKmS: 20 });
    assert.equal(r.scenario, 'asteroid');
    assert.ok(Math.abs(r.yieldKt - r.energyMt * 1000) < 1e-9);
    assert.ok(r.craterKm > 1, `crater=${r.craterKm} km`);
    assert.ok(r.overpressure.r20psiKm < r.overpressure.r5psiKm);
    assert.ok(r.overpressure.r5psiKm < r.overpressure.r1psiKm);
    assert.match(r.honesty, /not a hazard assessment/);
  });

  it('burst scenario labels yield and honesty', () => {
    const r = simulateBurst({ yieldKt: 15000 });
    assert.equal(r.energyMt, 15);
    assert.match(r.honesty, /Glasstone/);
  });

  it('tsunami scenario carries bathymetry caveat', () => {
    const r = simulateTsunami({});
    assert.match(r.honesty, /bathymetry/);
    assert.equal(r.rings.length, 5);
  });

  it('destinationPoint: 713 km due east from equator lands ~6.4° away', () => {
    const p = destinationPoint(0, 0, 90, 713);
    assert.ok(Math.abs(p.lat) < 0.01, `lat=${p.lat}`);
    assert.ok(Math.abs(p.lon - 6.41) < 0.05, `lon=${p.lon}`);
  });

  it('ringPolygon closes a 64-vertex ring', () => {
    const ring = ringPolygon(40, -70, 100);
    assert.equal(ring.length, 64);
    for (const p of ring) {
      assert.ok(p.lat >= -90 && p.lat <= 90);
      assert.ok(p.lon >= -180 && p.lon <= 180);
    }
    // first vertex due north of pin
    assert.ok(ring[0].lat > 40 && Math.abs(ring[0].lon + 70) < 0.01);
  });

  it('honesty banner is present and explicit', () => {
    assert.match(WHATIF_HONESTY, /Simplified educational model/);
    assert.match(WHATIF_HONESTY, /not a hazard assessment/);
  });
});
