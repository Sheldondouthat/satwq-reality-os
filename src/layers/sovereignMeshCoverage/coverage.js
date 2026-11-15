/**
 * Sovereign Mesh coverage compute — pure math, no Cesium, no network.
 *
 * The coverage source (sovereign-mesh-coverage, BM3 §4/§5) has no
 * endpoint and no payload of its own: its render is computed locally
 * from the SRTM terrain grid and the node set the nodes feed reports
 * — the same rule as RfCoverageLayer.cs and the Phase-0 placement run
 * (sovereign-mesh/placement.py), whose method this module mirrors:
 *
 *   line-of-sight + 60% of first Fresnel zone clear at 915 MHz,
 *   k=4/3 effective-earth-radius bulge correction, verdicts
 *   CLEAR / GRAZED / BLOCKED, and the placement run's margin mapping
 *   against its 157.0 dB reference link budget (CLEAR with FSPL
 *   excess >= 40 dB = strong, CLEAR = workable, GRAZED = marginal,
 *   BLOCKED = no coverage).
 *
 * Every output is Modeled, not measured (the FeedSpec's confidence
 * and the coverage attribution say so on the face). A terrain cell is
 * a coverage target with a 2 m antenna — the placement run's
 * assumption for a person holding a node. A mesh node's antenna
 * altitude is the altitude its own record reports
 * (altitude_m_reported), falling back to its SRTM ground elevation;
 * the records are taken as given, never adjusted.
 */
import {
  TERRAIN_ELEVATIONS_M,
  TERRAIN_LATS,
  TERRAIN_LONS,
} from './terrain.js';

export const FREQ_MHZ = 915.0;
export const LAMBDA_M = 299792458.0 / (FREQ_MHZ * 1e6);
export const R_EFF_M = (4.0 / 3.0) * 6371000.0;
export const LINK_BUDGET_DB = 157.0;
export const STRONG_EXCESS_DB = 40.0;
export const TARGET_ANTENNA_M = 2.0;

export const COVERAGE_MARGIN_CLASSES = Object.freeze([
  'strong',
  'workable',
  'marginal',
]);

const MARGIN_RANK = Object.freeze({
  strong: 3,
  workable: 2,
  marginal: 1,
  none: 0,
});

/** The bundled terrain grid in the compute's working shape. */
export const BUNDLED_TERRAIN_GRID = Object.freeze({
  lats: TERRAIN_LATS,
  lons: TERRAIN_LONS,
  elevationsM: TERRAIN_ELEVATIONS_M,
});

const num = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? v : null;

/** Bilinear SRTM elevation at (lat, lon); null outside the grid. */
export function elevationAt(grid, lat, lon) {
  const { lats, lons, elevationsM } = grid;
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    lat < lats[0] ||
    lat > lats[lats.length - 1] ||
    lon < lons[0] ||
    lon > lons[lons.length - 1]
  )
    return null;
  const frac = (axis, v) => {
    for (let i = 0; i < axis.length - 1; i += 1) {
      if (axis[i] <= v && v <= axis[i + 1])
        return [i, (v - axis[i]) / (axis[i + 1] - axis[i])];
    }
    return [axis.length - 2, 1.0];
  };
  const [i, ft] = frac(lats, lat);
  const [j, fu] = frac(lons, lon);
  const z00 = elevationsM[i][j];
  const z01 = elevationsM[i][j + 1];
  const z10 = elevationsM[i + 1][j];
  const z11 = elevationsM[i + 1][j + 1];
  if (z00 == null || z01 == null || z10 == null || z11 == null) return null;
  const a = z00 * (1 - fu) + z01 * fu;
  const b = z10 * (1 - fu) + z11 * fu;
  return a * (1 - ft) + b * ft;
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 6371.0 * 2 * Math.asin(Math.sqrt(a));
}

/**
 * One link verdict between two antennae ({lat, lon, antennaAltM}),
 * computed over the grid exactly as placement.py's link(): sample
 * the path, track the minimum clearance and the minimum Fresnel
 * margin (clearance − 0.6 × first-Fresnel radius), then classify.
 * Returns null when terrain along the path is unknowable (an end or
 * a sample outside the grid) — uncomputable, never guessed.
 */
export function linkVerdict(grid, from, to) {
  const distKm = haversineKm(from.lat, from.lon, to.lat, to.lon);
  const dist = distKm * 1000.0;
  if (dist < 1.0) {
    return {
      distKm: 0,
      verdict: 'CLEAR',
      minClearM: null,
      minFresnelMarginM: null,
      fsplDb: null,
      fsplExcessDb: null,
      marginClass: 'strong',
    };
  }
  const steps = Math.max(20, Math.floor(dist / 50.0));
  let minClear = Infinity;
  let minFresnelMargin = Infinity;
  for (let s = 1; s < steps; s += 1) {
    const t = s / steps;
    const lat = from.lat + (to.lat - from.lat) * t;
    const lon = from.lon + (to.lon - from.lon) * t;
    const terr = elevationAt(grid, lat, lon);
    if (terr == null) return null;
    const d1 = dist * t;
    const d2 = dist * (1 - t);
    const bulge = (d1 * d2) / (2 * R_EFF_M);
    const line = from.antennaAltM + (to.antennaAltM - from.antennaAltM) * t;
    const clearance = line - (terr + bulge);
    const fres = Math.sqrt((LAMBDA_M * d1 * d2) / (d1 + d2));
    const fresnelMargin = clearance - 0.6 * fres;
    if (clearance < minClear) minClear = clearance;
    if (fresnelMargin < minFresnelMargin) minFresnelMargin = fresnelMargin;
  }
  let verdict;
  if (minClear < 0) verdict = 'BLOCKED';
  else if (minFresnelMargin < 0) verdict = 'GRAZED';
  else verdict = 'CLEAR';
  const fsplDb =
    32.44 + 20 * Math.log10(FREQ_MHZ) + 20 * Math.log10(distKm);
  const fsplExcessDb = LINK_BUDGET_DB - fsplDb;
  let marginClass;
  if (verdict === 'BLOCKED') marginClass = 'none';
  else if (verdict === 'CLEAR' && fsplExcessDb >= STRONG_EXCESS_DB)
    marginClass = 'strong';
  else if (verdict === 'CLEAR') marginClass = 'workable';
  else marginClass = 'marginal';
  return {
    distKm,
    verdict,
    minClearM: minClear,
    minFresnelMarginM: minFresnelMargin,
    fsplDb,
    fsplExcessDb,
    marginClass,
  };
}

/**
 * A mesh node's antenna altitude, from its own normalized record:
 * the altitude the node reported, else its SRTM ground elevation,
 * else the grid under its position. Null when none is knowable.
 */
export function nodeAntennaAltM(grid, node) {
  const reported = num(node?.altitudeM);
  if (reported != null) return reported;
  const ground = num(node?.groundElevMSrtm);
  if (ground != null) return ground;
  if (typeof node?.lat === 'number' && typeof node?.lon === 'number')
    return elevationAt(grid, node.lat, node.lon);
  return null;
}

const betterThan = (candidate, best) => {
  if (!best) return true;
  const rankDelta =
    MARGIN_RANK[candidate.marginClass] - MARGIN_RANK[best.marginClass];
  if (rankDelta !== 0) return rankDelta > 0;
  const candFres =
    candidate.minFresnelMarginM == null
      ? Infinity
      : candidate.minFresnelMarginM;
  const bestFres =
    best.minFresnelMarginM == null ? Infinity : best.minFresnelMarginM;
  if (candFres !== bestFres) return candFres > bestFres;
  return candidate.distKm < best.distKm;
};

/**
 * Coverage cells for one snapshot node set. Each grid quad becomes a
 * target at its center (terrain + TARGET_ANTENNA_M); the cell is
 * covered when its best link to any node is not BLOCKED, and it
 * carries that best link's class and numbers. Blocked-everywhere
 * cells are simply absent — no cell is drawn claiming coverage the
 * model does not predict. Returns the cells plus the count of nodes
 * skipped for having no knowable antenna altitude.
 */
export function computeCoverage(nodes, grid = BUNDLED_TERRAIN_GRID) {
  const { lats, lons, elevationsM } = grid;
  const antennae = [];
  let skippedNodes = 0;
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const antennaAltM = nodeAntennaAltM(grid, node);
    if (antennaAltM == null) {
      skippedNodes += 1;
      continue;
    }
    antennae.push({
      id: node.id,
      shortname: node.shortname || node.id,
      lat: node.lat,
      lon: node.lon,
      antennaAltM,
    });
  }
  const cells = [];
  if (antennae.length === 0) return { cells, skippedNodes };
  for (let i = 0; i < lats.length - 1; i += 1) {
    for (let j = 0; j < lons.length - 1; j += 1) {
      const corners = [
        { lat: lats[i], lon: lons[j], elevM: elevationsM[i][j] },
        { lat: lats[i], lon: lons[j + 1], elevM: elevationsM[i][j + 1] },
        { lat: lats[i + 1], lon: lons[j + 1], elevM: elevationsM[i + 1][j + 1] },
        { lat: lats[i + 1], lon: lons[j], elevM: elevationsM[i + 1][j] },
      ];
      if (corners.some((c) => typeof c.elevM !== 'number')) continue;
      const lat = (lats[i] + lats[i + 1]) / 2;
      const lon = (lons[j] + lons[j + 1]) / 2;
      const terrainM = elevationAt(grid, lat, lon);
      if (terrainM == null) continue;
      const target = { lat, lon, antennaAltM: terrainM + TARGET_ANTENNA_M };
      let best = null;
      let bestNode = null;
      for (const antenna of antennae) {
        const link = linkVerdict(grid, target, antenna);
        if (!link) continue;
        if (betterThan(link, best)) {
          best = link;
          bestNode = antenna;
        }
      }
      if (!best || best.marginClass === 'none') continue;
      cells.push({
        row: i,
        col: j,
        lat,
        lon,
        terrainM,
        corners,
        bestNodeId: bestNode.id,
        bestShortname: bestNode.shortname,
        verdict: best.verdict,
        marginClass: best.marginClass,
        minClearM: best.minClearM,
        minFresnelMarginM: best.minFresnelMarginM,
        fsplExcessDb: best.fsplExcessDb,
        distKm: best.distKm,
      });
    }
  }
  return { cells, skippedNodes };
}
