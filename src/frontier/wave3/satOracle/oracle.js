/**
 * Satellite visibility oracle — "look up now". Wave 3 (1.6).
 *
 * Pure compute, no new API: TLEs come from the existing /api/celestrak/<group>
 * pipeline. SGP4 via the satellite.js dependency; Sun position, Earth-shadow
 * and pass geometry reuse src/data/satellitePass.js (USNO low-precision Sun,
 * cylindrical shadow — documented approximations, labeled as models).
 *
 * This module is Cesium-free and fetch-free so it is unit-testable in Node.
 */

import { twoline2satrec, propagate, eciToGeodetic, gstime } from 'satellite.js';
import {
  lookAnglesAt,
  isSatelliteSunlit,
  observerSolarElevation,
  findNextSatellitePass,
} from '../../../data/satellitePass.js';

const R2D = 180 / Math.PI;
const D2R = Math.PI / 180;

/** Parse 3-line TLE text into {name, line1, line2, satrec} records. */
export function parseTleText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const sats = [];
  for (let i = 0; i + 2 < lines.length; i += 3) {
    const name = lines[i].trim();
    const line1 = lines[i + 1].trim();
    const line2 = lines[i + 2].trim();
    if (!name || !line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;
    try {
      const satrec = twoline2satrec(line1, line2);
      sats.push({ name, line1, line2, satrec });
    } catch {
      /* malformed TLE — skip */
    }
  }
  return sats;
}

/** Sub-satellite point at an instant, or null when propagation fails. */
export function subSatellitePoint(satrec, dateMs) {
  let pv;
  try {
    pv = propagate(satrec, new Date(dateMs));
  } catch {
    return null;
  }
  const pos = pv && pv.position;
  if (
    !pos ||
    typeof pos === 'boolean' ||
    ![pos.x, pos.y, pos.z].every(Number.isFinite)
  )
    return null;
  const geo = eciToGeodetic(pos, gstime(new Date(dateMs)));
  return {
    latDeg: geo.latitude * R2D,
    lonDeg: geo.longitude * R2D,
    altKm: geo.height,
  };
}

/**
 * Satellites above the horizon AND sunlit right now — the "look up now" answer.
 * @returns {[{name, elevDeg, azDeg, sunlit:boolean, sunElevDeg}]} sorted by elevation desc
 */
export function currentlyVisible(
  satellites,
  latDeg,
  lonDeg,
  dateMs,
  { minElevDeg = 10 } = {},
) {
  const sunElevDeg = observerSolarElevation(latDeg, lonDeg, dateMs);
  const visible = [];
  for (const sat of satellites) {
    let look;
    try {
      look = lookAnglesAt(sat.satrec, dateMs, latDeg, lonDeg);
    } catch {
      continue;
    }
    if (!look || look.elevDeg < minElevDeg) continue;
    const sunlit = isSatelliteSunlit(look.satECI, dateMs);
    if (!sunlit) continue;
    visible.push({
      name: sat.name,
      elevDeg: look.elevDeg,
      azDeg: look.azDeg,
      sunElevDeg,
      sunlit: true,
    });
  }
  visible.sort((a, b) => b.elevDeg - a.elevDeg);
  return visible;
}

/**
 * Cheap candidate pre-filter for huge catalogs (e.g. ~8k Starlinks): keep
 * satellites whose ground track passes within maxGroundDeg of the observer
 * at any of the sampled instants. Final passes are still computed exactly
 * by findNextSatellitePass — this only narrows the candidate set.
 */
export function prefilterCandidates(
  satellites,
  latDeg,
  lonDeg,
  fromMs,
  { hours = 12, samples = 24, maxGroundDeg = 25 } = {},
) {
  const phi = latDeg * D2R;
  const kept = [];
  for (const sat of satellites) {
    let near = false;
    for (let s = 0; s < samples && !near; s++) {
      const t = fromMs + (s / Math.max(1, samples - 1)) * hours * 3600_000;
      const sub = subSatellitePoint(sat.satrec, t);
      if (!sub) continue;
      const dLat = (sub.latDeg - latDeg) * D2R;
      const dLon = (sub.lonDeg - lonDeg) * D2R;
      const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos(phi) * Math.cos(sub.latDeg * D2R) * Math.sin(dLon / 2) ** 2;
      const distDeg = 2 * Math.asin(Math.min(1, Math.sqrt(a))) * R2D;
      if (distDeg <= maxGroundDeg) near = true;
    }
    if (near) kept.push(sat);
  }
  return kept;
}

/**
 * Tonight's naked-eye passes: exact pass arcs via findNextSatellitePass,
 * filtered to twilight (observer Sun elevation in [-18°, -6°] at peak —
 * sky dark enough to see the sat, sat still sunlit above the shadow).
 * Returns passes sorted by peak time.
 */
export function tonightsVisiblePasses(
  satellites,
  latDeg,
  lonDeg,
  fromMs,
  { horizonHours = 14, minElevDeg = 10, maxResults = 40 } = {},
) {
  const passes = [];
  for (const sat of satellites) {
    let pass;
    try {
      pass = findNextSatellitePass({
        satrec: sat.satrec,
        latDeg,
        lonDeg,
        fromMs,
        minElevDeg,
        horizonHours,
        requireVisible: true,
        maxSunElevDeg: -6,
      });
    } catch {
      continue;
    }
    if (!pass) continue;
    const sunElevAtPeak = observerSolarElevation(
      latDeg,
      lonDeg,
      pass.maxElevMs,
    );
    if (sunElevAtPeak < -18 || sunElevAtPeak > -6) continue; // twilight window only
    passes.push({
      name: sat.name,
      riseMs: pass.riseMs,
      peakMs: pass.maxElevMs,
      setMs: pass.setMs,
      maxElevDeg: pass.maxElevDeg,
      riseAzDeg: pass.riseAzDeg,
      setAzDeg: pass.setAzDeg,
      sunElevAtPeakDeg: sunElevAtPeak,
    });
    if (passes.length >= maxResults) break;
  }
  passes.sort((a, b) => a.peakMs - b.peakMs);
  return passes;
}

/** Sampled sub-satellite points along a pass arc for globe rendering. */
export function passArcPoints(satrec, riseMs, setMs, stepMs = 60_000) {
  const points = [];
  for (let t = riseMs; t <= setMs; t += stepMs) {
    const sub = subSatellitePoint(satrec, t);
    if (sub) points.push({ t, ...sub });
  }
  const tail = subSatellitePoint(satrec, setMs);
  if (tail && (points.length === 0 || points[points.length - 1].t < setMs)) {
    points.push({ t: setMs, ...tail });
  }
  return points;
}

export { observerSolarElevation, isSatelliteSunlit, lookAnglesAt };
