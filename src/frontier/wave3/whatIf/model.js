/**
 * What-if simulator (wave3 sci-fi B #3) — public scaling laws, labeled as models.
 *
 * ALL outputs are simplified educational models, never hazard assessments:
 *  - Asteroid impact: kinetic energy E = 1/2 m v^2; crater via Schmidt–Holsapple
 *    Pi-scaling simplified to D(km) ≈ 1.8 * E_Mt^0.294 (dense rock, Earth g).
 *  - Overpressure radii: Glasstone–Dolan cube-root scaling (surface burst):
 *      R_20psi ≈ 0.28 * W^1/3 km   (severe structural damage)
 *      R_5psi  ≈ 0.62 * W^1/3 km   (most buildings collapse)
 *      R_1psi  ≈ 1.60 * W^1/3 km   (glass breakage)
 *    with W in kilotons. Validated against published 1 Mt reference radii.
 *  - Thermal (3rd-degree burns): R ≈ 1.2 * W^0.41 km, W in kt (clear-day approx).
 *  - Tsunami travel time: shallow-water wave speed c = sqrt(g * H),
 *    H = 4000 m → ≈ 713 km/h; arrival rings drawn at fixed hours.
 *
 * No new data required; pure client-side math. DOM/Cesium live in index.js.
 */

export const WHATIF_HONESTY =
  'Simplified educational model — not a hazard assessment. Effect rings use ' +
  'public scaling laws (Glasstone–Dolan overpressure, shallow-water wave ' +
  'speed) with flat-Earth, uniform-medium assumptions. Real impacts depend on ' +
  'entry angle, burst altitude, terrain, bathymetry and weather.';

export const G_M_S2 = 9.80665;
export const TNT_JOULES_PER_KT = 4.184e12;

export const SCENARIOS = {
  asteroid: 'Asteroid impact',
  burst: 'Surface burst (explosive yield)',
  tsunami: 'Tsunami source',
};

function num(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new TypeError(`${name} must be a positive finite number`);
  }
  return n;
}

/** Kinetic energy of an impactor, in megatons of TNT. */
export function impactEnergyMt({ diameterM, densityKgM3, velocityKmS }) {
  const d = num(diameterM, 'diameterM');
  const rho = num(densityKgM3, 'densityKgM3');
  const v = num(velocityKmS, 'velocityKmS') * 1000;
  const mass = (Math.PI / 6) * rho * d ** 3;
  const joules = 0.5 * mass * v * v;
  return joules / (TNT_JOULES_PER_KT * 1000);
}

/** Transient crater diameter in km (simplified Schmidt–Holsapple, dense rock). */
export function craterDiameterKm(energyMt) {
  const E = num(energyMt, 'energyMt');
  return 1.8 * E ** 0.294;
}

/**
 * Glasstone–Dolan overpressure radii for a surface burst.
 * @param {number} yieldKt yield in kilotons
 * @returns {{r20psiKm, r5psiKm, r1psiKm}}
 */
export function overpressureRadiiKm(yieldKt) {
  const W = num(yieldKt, 'yieldKt');
  const cbrt = W ** (1 / 3);
  return {
    r20psiKm: 0.28 * cbrt,
    r5psiKm: 0.62 * cbrt,
    r1psiKm: 1.6 * cbrt,
  };
}

/** Third-degree-burn thermal radius in km (clear day, Glasstone approx). */
export function thermalRadiusKm(yieldKt) {
  const W = num(yieldKt, 'yieldKt');
  return 1.2 * W ** 0.41;
}

/** Shallow-water tsunami wave speed, km/h, for mean ocean depth H (m). */
export function tsunamiSpeedKmh(depthM = 4000) {
  const H = num(depthM, 'depthM');
  return Math.sqrt(G_M_S2 * H) * 3.6;
}

/**
 * Tsunami arrival rings: great-circle distance reached after each hour.
 * @param {number[]} hours e.g. [1, 2, 4, 8, 12]
 * @returns {{hour, radiusKm}[]}
 */
export function tsunamiArrivalRings(hours = [1, 2, 4, 8, 12]) {
  const speed = tsunamiSpeedKmh();
  return hours.map((h) => {
    const hour = num(h, 'hour');
    return { hour, radiusKm: speed * hour };
  });
}

/** Full asteroid scenario → all displayable outputs. */
export function simulateAsteroid({
  diameterM,
  densityKgM3 = 3000,
  velocityKmS = 20,
}) {
  const energyMt = impactEnergyMt({ diameterM, densityKgM3, velocityKmS });
  const yieldKt = energyMt * 1000;
  return {
    scenario: 'asteroid',
    energyMt,
    yieldKt,
    craterKm: craterDiameterKm(energyMt),
    overpressure: overpressureRadiiKm(yieldKt),
    thermalKm: thermalRadiusKm(yieldKt),
    honesty: WHATIF_HONESTY,
  };
}

/** Surface burst scenario (user supplies yield directly). */
export function simulateBurst({ yieldKt }) {
  const W = num(yieldKt, 'yieldKt');
  return {
    scenario: 'burst',
    yieldKt: W,
    energyMt: W / 1000,
    overpressure: overpressureRadiiKm(W),
    thermalKm: thermalRadiusKm(W),
    honesty: WHATIF_HONESTY,
  };
}

/** Tsunami source scenario. */
export function simulateTsunami({
  depthM = 4000,
  hours = [1, 2, 4, 8, 12],
} = {}) {
  const rings = tsunamiArrivalRings(hours);
  return {
    scenario: 'tsunami',
    waveSpeedKmh: tsunamiSpeedKmh(depthM),
    depthM: num(depthM, 'depthM'),
    rings,
    honesty:
      WHATIF_HONESTY +
      ' Tsunami model assumes a uniform 4000 m ocean and radial spread — ' +
      'real travel times follow bathymetry, refraction and coastal trapping.',
  };
}

/** Great-circle destination point (spherical Earth) — for ring rendering. */
export function destinationPoint(latDeg, lonDeg, bearingDeg, distanceKm) {
  const R = 6371;
  const [la1, lo1, br] = [latDeg, lonDeg, bearingDeg].map(
    (d) => (d * Math.PI) / 180,
  );
  const ad = distanceKm / R;
  const la2 = Math.asin(
    Math.sin(la1) * Math.cos(ad) + Math.cos(la1) * Math.sin(ad) * Math.cos(br),
  );
  const lo2 =
    lo1 +
    Math.atan2(
      Math.sin(br) * Math.sin(ad) * Math.cos(la1),
      Math.cos(ad) - Math.sin(la1) * Math.sin(la2),
    );
  return {
    lat: (la2 * 180) / Math.PI,
    lon: (((lo2 * 180) / Math.PI + 540) % 360) - 180,
  };
}

/** 64-vertex ring polygon around a pin — renderer input. */
export function ringPolygon(latDeg, lonDeg, radiusKm, segments = 64) {
  const pts = [];
  for (let i = 0; i < segments; i += 1) {
    pts.push(destinationPoint(latDeg, lonDeg, (i * 360) / segments, radiusKm));
  }
  return pts;
}
