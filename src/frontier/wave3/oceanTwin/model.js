/**
 * Ocean twin (wave3 sci-fi B #2) — current-particle field model.
 *
 * Pure, DOM-free: spatial index over an irregular [lat,lon,u,v] point set,
 * inverse-distance sampling of the vector field, and particle advection with
 * respawn. Provenance lives in CURRENT_SNAPSHOT and is rendered by index.js.
 *
 * Physics honesty: particles advect on a DECIMATED SNAPSHOT of one RTOFS
 * analysis cycle (2026-09-26), not live observations. Coarse (~3°) grid;
 * fine structure (eddies < ~300 km) is absent. Land-masked points are
 * simply missing from the set.
 */

export const CURRENT_SNAPSHOT = {
  source: 'NOAA RTOFS v2.5 global nowcast analysis (rtofs_glo_2ds_n000_prog)',
  validTime: '2026-09-26T00:00:00Z',
  units: 'm/s (surface u/v)',
  grid: 'native 1/12° tripolar decimated to ~3° for the twin',
  note: 'Snapshot, not live. Particle motion is stylized advection on this snapshot.',
};

export const PARTICLE_COUNT = 1500;
/** Respawn a particle after this many simulated hours, or when lost. */
export const PARTICLE_LIFETIME_H = 72;

/** Point record: [lat, lon, u, v]. */
export function validatePoints(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return { ok: false, reason: 'empty point set' };
  }
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (!Array.isArray(p) || p.length !== 4 || p.some((v) => !Number.isFinite(v))) {
      return { ok: false, reason: `point ${i} malformed` };
    }
    const [lat, lon] = p;
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { ok: false, reason: `point ${i} out of range` };
    }
  }
  return { ok: true, reason: null };
}

/**
 * Uniform-grid spatial index: cellDeg -> array of point indices.
 * Returns { index: Map, cellDeg }.
 */
export function buildSpatialIndex(points, cellDeg = 5) {
  const index = new Map();
  const key = (lat, lon) =>
    `${Math.floor(lat / cellDeg)},${Math.floor((lon + 180) / cellDeg)}`;
  points.forEach((p, i) => {
    const k = key(p[0], p[1]);
    let arr = index.get(k);
    if (!arr) index.set(k, (arr = []));
    arr.push(i);
  });
  return { index, cellDeg, key };
}

/** Gather candidate point indices from the cell + its 8 neighbors. */
function nearbyIndices(spatial, lat, lon, points) {
  const { index, cellDeg, key } = spatial;
  const out = [];
  const cy = Math.floor(lat / cellDeg);
  const cx = Math.floor((lon + 180) / cellDeg);
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const arr = index.get(`${cy + dy},${cx + dx}`);
      if (arr) out.push(...arr);
    }
  }
  return out;
}

/**
 * Sample (u,v) at lat/lon via inverse-distance weighting of nearby points.
 * Returns null when no data is near (land gaps / domain edge).
 */
export function sampleCurrent(spatial, points, lat, lon, maxDistDeg = 8) {
  const ids = nearbyIndices(spatial, lat, lon, points);
  let su = 0, sv = 0, sw = 0;
  for (const i of ids) {
    const p = points[i];
    const dLat = p[0] - lat;
    let dLon = Math.abs(p[1] - lon);
    if (dLon > 180) dLon = 360 - dLon;
    const d = Math.hypot(dLat, dLon);
    if (d > maxDistDeg) continue;
    const w = 1 / (d * d + 0.04);
    su += p[2] * w; sv += p[3] * w; sw += w;
  }
  if (sw === 0) return null;
  return { u: su / sw, v: sv / sw };
}

/** Spawn particles at random ocean points (seeded RNG for tests). */
export function createParticles(points, count, rng = Math.random) {
  const ps = [];
  for (let i = 0; i < count; i += 1) {
    const p = points[Math.floor(rng() * points.length)];
    ps.push({ lat: p[0], lon: p[1], ageH: rng() * PARTICLE_LIFETIME_H });
  }
  return ps;
}

/** Respawn helper — picks a fresh ocean point. */
export function respawn(particle, points, rng = Math.random) {
  const p = points[Math.floor(rng() * points.length)];
  particle.lat = p[0];
  particle.lon = p[1];
  particle.ageH = 0;
}

/**
 * Advect particles dtHours through the field. Returns count respawned.
 * Spherical update: dlat from v, dlon from u / cos(lat).
 */
export function advectParticles(particles, spatial, points, dtHours, rng = Math.random) {
  const dtS = dtHours * 3600;
  let respawned = 0;
  for (const pt of particles) {
    pt.ageH += dtHours;
    const c = sampleCurrent(spatial, points, pt.lat, pt.lon);
    if (!c || pt.ageH > PARTICLE_LIFETIME_H) {
      respawn(pt, points, rng);
      respawned += 1;
      continue;
    }
    const speed = Math.hypot(c.u, c.v);
    // Near-stagnant water: let the particle age out in place.
    if (speed < 0.005) continue;
    const dLat = ((c.v * dtS) / 111320);
    const dLon = (c.u * dtS) / (111320 * Math.max(0.2, Math.cos((pt.lat * Math.PI) / 180)));
    pt.lat += dLat;
    pt.lon += dLon;
    if (pt.lon > 180) pt.lon -= 360;
    if (pt.lon < -180) pt.lon += 360;
    if (Math.abs(pt.lat) > 84) {
      respawn(pt, points, rng);
      respawned += 1;
    }
  }
  return respawned;
}

/** Validate the snapshot document shape. */
export function validateSnapshot(doc) {
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'not an object' };
  const check = validatePoints(doc.points);
  if (!check.ok) return check;
  if (typeof doc.validTime !== 'string' || typeof doc.units !== 'string') {
    return { ok: false, reason: 'missing validTime/units' };
  }
  return { ok: true, reason: null };
}
