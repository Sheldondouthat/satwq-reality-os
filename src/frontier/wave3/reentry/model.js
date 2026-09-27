/**
 * TLE decay prediction (3.4) — pure model + SGP4 ground-track helpers.
 *
 * Land-overflight detection uses a coarse built-in land test: a list of
 * lon/lat rectangles approximating the continents, accurate to roughly ±5°.
 * It is EXPLICITLY a heuristic — coastlines are fuzzy at this resolution and
 * the underlying TCA is itself a crude drag-extrapolation model. Everything
 * that surfaces it carries that label.
 */
import { twoline2satrec, propagate, gstime, eciToGeodetic } from 'satellite.js';

export const REENTRY_HONESTY =
  'Reentry timing is a CRUDE MODEL: linear extrapolation of the TLE first ' +
  'derivative of mean motion, not a real decay integration. Windows are ' +
  '±25% heuristic bands. Land-overflight alerts use a coarse built-in land ' +
  'test (±5°) — coastlines are fuzzy and the TCA itself is uncertain. ' +
  'Treat every number here as an ambient model output, not a prediction.';

/**
 * Coarse continent rectangles: [lonMin, lonMax, latMin, latMax].
 * Overlaps are fine (OR test). Resolution ~±5°, documented as heuristic.
 */
export const LAND_BOXES = [
  [-170, -55, 15, 72], // North America
  [-92, -60, 7, 28], // Central America / Caribbean
  [-60, -20, 60, 84], // Greenland
  [-80, -35, -55, 12], // South America
  [-25, -13, 63, 67], // Iceland
  [-10, 40, 36, 71], // Europe
  [-6, 2, 49, 59], // British Isles
  [-18, 50, -35, 35], // Africa
  [43, 51, -26, -12], // Madagascar
  [40, 180, 40, 75], // Russia / Central Asia
  [35, 95, 5, 40], // Middle East / South Asia
  [75, 135, 18, 53], // China
  [124, 130, 34, 43], // Korea
  [129, 146, 31, 46], // Japan
  [95, 125, -10, 20], // SE Asia
  [95, 120, -11, 7], // Indonesia (west)
  [131, 147, -11, 0], // New Guinea
  [113, 154, -40, -10], // Australia
  [166, 179, -47, -34], // New Zealand
  [-180, 180, -90, -60], // Antarctica
];

/** Coarse land test. Returns true = probably land (heuristic, ±5°). */
export function isLandApprox(lat, lon) {
  for (const [lo0, lo1, la0, la1] of LAND_BOXES) {
    if (lon >= lo0 && lon <= lo1 && lat >= la0 && lat <= la1) return true;
  }
  return false;
}

const RAD2DEG = 180 / Math.PI;

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Defensive coercion of a provider candidate. Null on garbage. */
export function coerceCandidate(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tcaMs = Date.parse(raw.tcaUtc);
  const tcaDays = numOrNull(raw.tcaDays);
  if (!Number.isFinite(tcaMs) || tcaDays === null || tcaDays < 0) return null;
  const tle = raw.tle && typeof raw.tle.line1 === 'string' && typeof raw.tle.line2 === 'string' ? raw.tle : null;
  return {
    id: typeof raw.id === 'string' ? raw.id : `re-${tcaMs}`,
    name: String(raw.name ?? 'UNKNOWN'),
    noradId: String(raw.noradId ?? ''),
    tcaUtc: new Date(tcaMs).toISOString(),
    tcaMs,
    tcaDays,
    windowHours: numOrNull(raw.windowHours),
    daysLow: numOrNull(raw.daysLow),
    daysHigh: numOrNull(raw.daysHigh),
    urg: ['critical', 'elevated', 'watch'].includes(raw.urg) ? raw.urg : 'nominal',
    meanMotion: numOrNull(raw.meanMotion),
    tle,
  };
}

export const URGENCY_STYLE = {
  critical: { label: 'CRITICAL', color: '#ff3b3b' },
  elevated: { label: 'ELEVATED', color: '#ff9f5a' },
  watch: { label: 'WATCH', color: '#ffd166' },
  nominal: { label: 'TRACKED', color: '#7ee2a8' },
};

/** SGP4 geodetic position at an epoch ms. Null on failure. */
export function propagateGeodetic(tle, epochMs) {
  try {
    const satrec = twoline2satrec(tle.line1, tle.line2);
    const date = new Date(epochMs);
    const pv = propagate(satrec, date);
    if (!pv || !pv.position) return null;
    const geo = eciToGeodetic(pv.position, gstime(date));
    if (!Number.isFinite(geo.latitude) || !Number.isFinite(geo.longitude)) return null;
    return { lat: geo.latitude * RAD2DEG, lon: geo.longitude * RAD2DEG, altKm: geo.height };
  } catch {
    return null;
  }
}

/**
 * Final-orbit ground track: from (orbitsBack × period) before centerMs up to
 * centerMs, sampled every stepSec. Returns [lon, lat, heightM] triples.
 */
export function groundTrack(tle, centerMs, { orbitsBack = 3, stepSec = 60 } = {}) {
  if (!tle || !Number.isFinite(centerMs)) return [];
  let periodMin = 100;
  try {
    const satrec = twoline2satrec(tle.line1, tle.line2);
    // satellite.js v6 stores mean motion (rad/min) as `no` — NOT `no_kozai`
    // (an older field name). Using the wrong name silently fell back to 100.
    if (satrec.no && Number.isFinite(satrec.no) && satrec.no > 0) {
      periodMin = (2 * Math.PI) / satrec.no;
    }
  } catch { /* fall through with default */ }
  const spanMs = orbitsBack * periodMin * 60_000;
  const out = [];
  for (let ms = centerMs - spanMs; ms <= centerMs; ms += stepSec * 1000) {
    const p = propagateGeodetic(tle, ms);
    if (p) out.push([p.lon, p.lat, Math.max(1000, p.altKm * 1000)]);
  }
  return out;
}

/**
 * Uncertainty band: nominal final-orbit track plus the same track shifted by
 * ±window (daysLow/daysHigh from the provider model). The outer tracks render
 * dim — the honest visual for "we don't know exactly when".
 */
export function uncertaintyBand(candidate, { orbitsBack = 3, stepSec = 120 } = {}) {
  if (!candidate.tle) return null;
  const nominal = groundTrack(candidate.tle, candidate.tcaMs, { orbitsBack, stepSec });
  const halfLow = candidate.daysLow !== null ? (candidate.tcaDays - candidate.daysLow) : 0;
  const halfHigh = candidate.daysHigh !== null ? (candidate.daysHigh - candidate.tcaDays) : 0;
  const early = groundTrack(candidate.tle, candidate.tcaMs - halfLow * 86400_000, { orbitsBack, stepSec });
  const late = groundTrack(candidate.tle, candidate.tcaMs + halfHigh * 86400_000, { orbitsBack, stepSec });
  return { nominal, early, late };
}

/**
 * Land-overflight analysis of a ground track. Explicitly heuristic.
 * @returns {{points, landPoints, oceanPoints, crossesLand, note}}
 */
export function overflightAlert(track) {
  let landPoints = 0;
  for (const [lon, lat] of track) {
    if (isLandApprox(lat, lon)) landPoints++;
  }
  const oceanPoints = track.length - landPoints;
  return {
    points: track.length,
    landPoints,
    oceanPoints,
    crossesLand: landPoints > 0,
    note: 'heuristic land test (±5°), on a modeled track — not a prediction',
  };
}

/** Human timing line: "T-3.2d ± 1.1d window". */
export function formatTiming(c) {
  const half = c.windowHours !== null ? c.windowHours / 2 : null;
  const t = c.tcaDays < 1 ? `${Math.round(c.tcaDays * 24)}h` : `${c.tcaDays.toFixed(1)}d`;
  return half !== null ? `T-${t} ± ${half.toFixed(1)}h window (modeled)` : `T-${t} (modeled)`;
}

/** Sort: most urgent TCA first. */
export function rankCandidates(candidates) {
  return [...candidates].sort((a, b) => a.tcaMs - b.tcaMs);
}
