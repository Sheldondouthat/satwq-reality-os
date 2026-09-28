/**
 * Wave 3 / Track 2a.5 — DONKI CME-arc client model (pure, no Cesium).
 *
 * HONESTY: Earth-directedness is a heuristic (source near disk center or
 * wide/halo cone or analyst note); ETA is a ballistic constant-speed
 * model. Both are labeled as models in the legend.
 */

/** Approximate subsolar point (lat/lon degrees) for a date. Pure math. */
export function subsolarPoint(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const start = Date.UTC(d.getUTCFullYear(), 0, 0);
  const dayOfYear = Math.floor((d.getTime() - start) / 86400_000);
  const decl = -23.44 * Math.cos(((2 * Math.PI) / 365) * (dayOfYear + 10));
  const utcHours = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600;
  let lon = 180 - utcHours * 15;
  if (lon > 180) lon -= 360;
  return { lat: decl, lon };
}

/** CME arc color by speed: slow amber -> fast red -> extreme violet. */
export function speedColor(speedKms) {
  if (!Number.isFinite(speedKms)) return '#8a93a6';
  if (speedKms < 500) return '#ffb454';
  if (speedKms < 1000) return '#ff7a3d';
  if (speedKms < 1500) return '#ff5a5a';
  return '#c44dff';
}

/** Human countdown to an ETA timestamp. */
export function etaCountdown(etaMs, now = Date.now()) {
  if (!Number.isFinite(etaMs)) return 'ETA n/a';
  const diff = etaMs - now;
  if (diff <= 0) return 'arriving now';
  const h = Math.floor(diff / 3600_000);
  const m = Math.floor((diff % 3600_000) / 60_000);
  if (h >= 48) return `${Math.floor(h / 24)}d ${h % 24}h`;
  if (h >= 1) return `${h}h ${m}m`;
  return `${m}m`;
}

export function cmeLabel(cme, now = Date.now()) {
  const parts = [];
  if (Number.isFinite(cme.speedKms)) parts.push(`${Math.round(cme.speedKms)} km/s`);
  parts.push(etaCountdown(cme.etaMs, now));
  if (cme.sourceLocation) parts.push(cme.sourceLocation);
  return parts.join(' · ');
}

/**
 * Sample a quadratic bezier arc (lon/lat degrees + height metres) from the
 * Sun-side start point to the Earth impact point. Returns [lon,lat,h] rows.
 */
export function arcSamples(start, impact, segments = 48) {
  // control point: pushed outward from Earth, biased toward the sun side
  const ctrl = {
    lon: (start.lon + impact.lon) / 2,
    lat: (start.lat + impact.lat) / 2 + 18,
    h: Math.max(start.h, impact.h) * 1.6,
  };
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push([
      u * u * start.lon + 2 * u * t * ctrl.lon + t * t * impact.lon,
      u * u * start.lat + 2 * u * t * ctrl.lat + t * t * impact.lat,
      u * u * start.h + 2 * u * t * ctrl.h + t * t * impact.h,
    ]);
  }
  return out;
}

/**
 * Wave-6 bundle adapters (added 2026-09-28).
 *
 * /api/donki is now served by server/providers/wave6/donki.js, which returns
 * the full bundle {cme:[...], flares:[...], ...} instead of the old
 * per-type {events:[...]} documents. These pure adapters reshape wave6 items
 * into the {earthDirected, speedKms, etaMs, sourceLocation} records the
 * CME-arc renderer consumes.
 *
 * The Earth-directedness heuristic and ballistic ETA are MODELS (same as
 * before): disk-center source, halo-wide cone, or analyst note says
 * Earth-directed; ETA assumes constant speed over 1 AU. Ported from
 * server/providers/wave3/donki.js (isEarthDirected, ballisticTransitHours)
 * so the client bundle stays self-contained.
 */
const AU_KM = 149_597_870.7;

/** Null-safe number: null/undefined stay missing instead of becoming 0. */
function num(v) {
  return v == null || v === '' ? Number.NaN : Number(v);
}

/** Heuristic Earth-directedness for a wave6 CME analysis object. MODEL. */
export function isEarthDirectedWave6(analysis, note = '') {
  if (!analysis) return false;
  const lat = num(analysis.latitude);
  const lon = num(analysis.longitude);
  const halfAngle = num(analysis.halfAngle);
  const text = `${note} ${analysis.note ?? ''}`.toLowerCase();
  if (/earth-directed|earth directed|halo/.test(text)) return true;
  if (Number.isFinite(halfAngle) && halfAngle >= 90) return true;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return Math.abs(lat) <= 45 && Math.abs(lon) <= 60;
  }
  return false;
}

/** Ballistic Sun->Earth transit hours at constant speed. MODEL. */
export function ballisticTransitHoursWave6(speedKms) {
  if (!Number.isFinite(speedKms) || speedKms <= 0) return null;
  return AU_KM / speedKms / 3600;
}

/** Reshape one wave6 cme item into the render record. */
export function adaptWave6Cme(item) {
  const analysis = item?.analysis ?? null;
  const speedKms = num(analysis?.speedKms);
  const startMs = Date.parse(item?.startTime ?? '');
  const transitHours = ballisticTransitHoursWave6(speedKms);
  return {
    id: item?.id ?? null,
    sourceLocation: item?.sourceLocation ?? '',
    note: item?.note ?? '',
    speedKms: Number.isFinite(speedKms) ? speedKms : null,
    earthDirected: isEarthDirectedWave6(analysis, item?.note ?? ''),
    etaMs:
      Number.isFinite(startMs) && transitHours != null
        ? startMs + transitHours * 3600_000
        : null,
  };
}

/** Reshape one wave6 flare item into the dock record. */
export function adaptWave6Flare(item) {
  const peakMs = Date.parse(item?.peakTime ?? '');
  return {
    id: item?.id ?? null,
    class: item?.class ?? null,
    peakMs: Number.isFinite(peakMs) ? peakMs : null,
    sourceLocation: item?.sourceLocation ?? '',
  };
}
