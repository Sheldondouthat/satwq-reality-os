/**
 * lightning/model.js — F4 lightning "nervous system" layer: pure data model.
 *
 * Cesium-free by design: everything here is plain math and plain objects so
 * it runs under node --test without a browser. src/layers/lightning/index.js
 * converts these values into Cesium entities.
 *
 * DATA HONESTY: there is no keyless real-time lightning-strike feed (see
 * source.js research notes). Strikes here are MODELED from RainViewer radar
 * reflectivity (warm-pixel convective cells) and carry `modeled: true` plus
 * the source label "Modeled from radar". Never present them as detections.
 */

import { subsolarPoint } from '../terminator/model.js';

export const LIGHTNING_LAYER_ID = 'lightning';
export const LIGHTNING_OVERLAY_SOURCE_ID = 'lightning';
export const LIGHTNING_OVERLAY_COHORT_LIMIT = 0; // per-strike overlay churn is entity-only by design
export const LIGHTNING_OVERLAY_COLLISION_CAPACITY = 0;

/** Human-readable source label — must say "modeled". */
export const LIGHTNING_SOURCE_LABEL = 'Modeled from radar';

/** How long a strike flash stays visible (ms) before it decays to nothing. */
export const STRIKE_TTL_MS = 4200;

/** Hard cap on live flash entities so a convective outbreak can't flood Cesium. */
export const MAX_ACTIVE_STRIKES = 240;

/** Strikes spawn only where the solar zenith angle exceeds this (deg from subsolar point). */
export const NIGHT_MARGIN_DEG = 95;

/** Radar tiles are sampled at this zoom (z=3 → 8×8 world grid, 16-tile default budget). */
export const RADAR_TILE_Z = 3;
export const TILE_PX = 256;
/** Each tile is subdivided into a CELL_GRID×CELL_GRID candidate-cell matrix. */
export const CELL_GRID = 4;

/** Warm-color heuristic thresholds (RainViewer radar palette: orange/red/magenta = high dBZ). */
export const CONVECTIVE_R_MIN = 200;
export const CONVECTIVE_G_MIN = 40; // low enough to admit magenta bins, high enough with the R gate to exclude nothing green
export const CONVECTIVE_B_MAX = 130;
/** Minimum warm-pixel fraction for a cell to count as convective. */
export const CONVECTIVE_CELL_THRESHOLD = 0.02;
/** Warm-pixel fraction that saturates intensity at 1.0. */
export const CONVECTIVE_CELL_SATURATION = 0.15;

/** Flash color ramp (white core → blue-violet halo), plain {r,g,b} for testability. */
export const STRIKE_CORE_COLOR = Object.freeze({ r: 1, g: 1, b: 1 });
export const STRIKE_HALO_COLOR = Object.freeze({ r: 0.45, g: 0.55, b: 1 });

/**
 * Seeded PRNG (mulberry32) — deterministic strike sampling for tests and
 * stable demo behavior. Returns a function yielding floats in [0, 1).
 */
export function createSeededRng(seed = 0x9e3779b9) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Angular distance in degrees between two lat/lon points. */
export function angularDistanceDeg(latA, lonA, latB, lonB) {
  const r = Math.PI / 180;
  const dLat = (latB - latA) * r;
  const dLon = (lonB - lonA) * r;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(latA * r) * Math.cos(latB * r) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(a))) * (180 / Math.PI);
}

/**
 * True when (lat, lon) is on the night side at `date` — i.e. the point is
 * more than NIGHT_MARGIN_DEG away from the subsolar point, so flashes render
 * against dark terrain where they are actually visible.
 */
export function isNightSide(lat, lon, date = new Date()) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90)
    return false;
  const t = date instanceof Date ? date.getTime() : NaN;
  if (!Number.isFinite(t)) return false; // bad date → not night, never throws
  const sub = subsolarPoint(date);
  return angularDistanceDeg(lat, lon, sub.lat, sub.lon) > NIGHT_MARGIN_DEG;
}

/**
 * Flash brightness envelope: 1 at ignition → 0 at STRIKE_TTL_MS.
 * Quick snap-on, linear-ish decay; purely a visual curve.
 */
export function decayAlpha(ageMs, ttlMs = STRIKE_TTL_MS) {
  if (!Number.isFinite(ageMs) || ageMs <= 0) return 1;
  if (!Number.isFinite(ttlMs) || ttlMs <= 0 || ageMs >= ttlMs) return 0;
  return 1 - ageMs / ttlMs;
}

/**
 * Flash color for a strike of `intensity` in [0,1]: white core blended toward
 * the blue-violet halo at high intensity. Returns plain {r,g,b,alpha}.
 */
export function strikeFlashColor(intensity, ageMs = 0, ttlMs = STRIKE_TTL_MS) {
  const k = clamp(intensity ?? 0.5, 0, 1);
  return {
    r: STRIKE_CORE_COLOR.r + (STRIKE_HALO_COLOR.r - STRIKE_CORE_COLOR.r) * k,
    g: STRIKE_CORE_COLOR.g + (STRIKE_HALO_COLOR.g - STRIKE_CORE_COLOR.g) * k,
    b: STRIKE_CORE_COLOR.b + (STRIKE_HALO_COLOR.b - STRIKE_CORE_COLOR.b) * k,
    alpha: decayAlpha(ageMs, ttlMs),
  };
}

/**
 * Warm-pixel test on the RainViewer radar palette: orange/red/magenta pixels
 * are the high-dBZ (convective) bins; greens/blues are stratiform rain.
 * This is a heuristic, not a measurement — see module header.
 */
export function isConvectivePixel(r, g, b) {
  return (
    r >= CONVECTIVE_R_MIN && g >= CONVECTIVE_G_MIN && b <= CONVECTIVE_B_MAX
  );
}

/** Convert a warm-pixel fraction into a 0..1 strike intensity. */
export function intensityFromWarmFraction(warmFraction) {
  if (
    !Number.isFinite(warmFraction) ||
    warmFraction < CONVECTIVE_CELL_THRESHOLD
  )
    return 0;
  return clamp(warmFraction / CONVECTIVE_CELL_SATURATION, 0, 1);
}

/** Convert a WebMercator tile+pixel coordinate to lon/lat degrees. */
export function tilePixelToLonLat(tileX, tileY, px, py, z = RADAR_TILE_Z) {
  const n = 2 ** z;
  const lon = ((tileX + px / TILE_PX) / n) * 360 - 180;
  const latRad = Math.atan(
    Math.sinh(Math.PI * (1 - (2 * (tileY + py / TILE_PX)) / n)),
  );
  return { lat: (latRad * 180) / Math.PI, lon };
}

/** Center of candidate cell (i, j) inside tile (tileX, tileY). */
export function cellCenter(tileX, tileY, i, j, z = RADAR_TILE_Z) {
  const cellPx = TILE_PX / CELL_GRID;
  return tilePixelToLonLat(
    tileX,
    tileY,
    (i + 0.5) * cellPx,
    (j + 0.5) * cellPx,
    z,
  );
}

/** Stable id for a candidate cell. */
export function cellIdFor(tileX, tileY, i, j) {
  return `lightning:cell:${tileX}:${tileY}:${i}:${j}`;
}

/**
 * Jitter a strike inside its cell by up to ±jitterDeg. Pure + seeded.
 */
export function jitterStrike(cell, rng, jitterDeg = 4) {
  const dLat = (rng() * 2 - 1) * jitterDeg;
  const dLon = (rng() * 2 - 1) * jitterDeg;
  return {
    lat: clamp(cell.lat + dLat, -90, 90),
    lon: ((cell.lon + dLon + 540) % 360) - 180,
  };
}

/**
 * Sample `count` strike impulses from weighted candidate cells.
 * Cells with higher intensity are picked more often. Each strike carries
 * `modeled: true` so no downstream consumer can mistake it for a detection.
 *
 * @param {Array<{lat,lon,intensity,cellId}>} cells
 * @param {object} [options]
 */
export function sampleStrikes(
  cells,
  { count = 24, rng = Math.random, nowMs = Date.now(), batch = 0 } = {},
) {
  const live = (Array.isArray(cells) ? cells : []).filter(
    (c) =>
      c &&
      Number.isFinite(c.lat) &&
      Number.isFinite(c.lon) &&
      Number.isFinite(c.intensity) &&
      c.intensity > 0,
  );
  if (live.length === 0 || count <= 0) return [];
  const total = live.reduce((s, c) => s + c.intensity, 0);
  const strikes = [];
  for (let k = 0; k < count; k += 1) {
    let pick = rng() * total;
    let cell = live[live.length - 1];
    for (const c of live) {
      pick -= c.intensity;
      if (pick <= 0) {
        cell = c;
        break;
      }
    }
    const { lat, lon } = jitterStrike(cell, rng);
    strikes.push({
      id: `lightning:strike:${nowMs}:${batch}:${k}`,
      lat,
      lon,
      intensity: cell.intensity,
      cellId: cell.cellId ?? null,
      timeMs: nowMs,
      modeled: true,
      sourceLabel: LIGHTNING_SOURCE_LABEL,
    });
  }
  return strikes;
}

/**
 * Analyst-record mapping for a strike (kept minimal: strikes are impulses,
 * not persistent features).
 */
export function mapAnalystRecord(strike, index = 0) {
  if (!strike) return null;
  return {
    id: strike.id ?? `lightning:strike:${index}`,
    kind: 'lightning',
    lat: strike.lat,
    lon: strike.lon,
    timeMs: strike.timeMs ?? null,
    intensity: strike.intensity ?? null,
    modeled: true,
  };
}

/** Overlay entry factory (unused for per-strike churn — see index.js note). */
export function createLightningOverlayEntry() {
  return null;
}
