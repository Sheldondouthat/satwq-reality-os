/**
 * Radiation map client (wave3 sci-fi B #4) — pure helpers.
 *
 * Dose-band coloring and /api/radiation payload validation. Rendering lives
 * in index.js. Bands are display-only; they are not health advice.
 *
 * doseBand/DOSE_BANDS live in the neutral shared module (shared/radiationBands.js)
 * so the server provider can use them without a server→src import.
 */
export { DOSE_BANDS, doseBand } from '../../../../shared/radiationBands.js';

export const BAND_COLORS = {
  low: '#35e0ff',
  background: '#7dff6a',
  elevated: '#ffd21a',
  high: '#ff2d2d',
  unknown: '#9fb4dd',
};

export const BAND_LABELS = {
  low: '< 0.10 µSv/h — low',
  background: '0.10–0.30 µSv/h — typical background',
  elevated: '0.30–1.0 µSv/h — elevated',
  high: '> 1.0 µSv/h — high (verify sensor)',
  unknown: 'no reading',
};

export function validateRadiationPayload(payload) {
  if (!payload || typeof payload !== 'object')
    return { ok: false, reason: 'not an object' };
  if (!Array.isArray(payload.points))
    return { ok: false, reason: 'points missing' };
  for (let i = 0; i < payload.points.length; i += 1) {
    const p = payload.points[i];
    if (
      !p ||
      !Number.isFinite(p.lat) ||
      !Number.isFinite(p.lon) ||
      !Number.isFinite(p.valueUsvH) ||
      Math.abs(p.lat) > 90 ||
      Math.abs(p.lon) > 180
    ) {
      return { ok: false, reason: `point ${i} malformed` };
    }
  }
  return { ok: true, reason: null };
}

/** Latest reading per coarse cell — declutters mobile-drive streaks. */
export function declutterByCell(points, cellDeg = 1) {
  const seen = new Map();
  for (const p of points) {
    const k = `${Math.floor(p.lat / cellDeg)},${Math.floor((p.lon + 180) / cellDeg)}`;
    if (!seen.has(k)) seen.set(k, p);
  }
  return [...seen.values()];
}

/**
 * Wave-6 bundle adapter (added 2026-09-28).
 *
 * /api/radiation is now served by server/providers/wave6/radiation.js, which
 * returns {stations:[{lat,lon,usvPerHour,...}], radonStations:[...]} instead
 * of the old Safecast {points:[...]} document. This maps wave6 stations to
 * the {lat,lon,valueUsvH,unit,capturedAt} points the renderer consumes.
 *
 * HONESTY: stations that report only CPM (no µSv/h) are SKIPPED — CPM→µSv/h
 * conversion is tube-specific and must not be faked. radonStations carry
 * pCi/L / Bq/m³ (a different quantity) and are not plotted as dose dots.
 */
export function stationsToPoints(payload) {
  if (!payload || typeof payload !== 'object') return { points: [] };
  if (Array.isArray(payload.points)) return { points: payload.points }; // legacy passthrough
  const stations = Array.isArray(payload.stations) ? payload.stations : [];
  const points = [];
  for (const s of stations) {
    if (!s || !Number.isFinite(s.lat) || !Number.isFinite(s.lon)) continue;
    if (!Number.isFinite(s.usvPerHour)) continue; // CPM-only: skip, don't fake
    if (Math.abs(s.lat) > 90 || Math.abs(s.lon) > 180) continue;
    points.push({
      lat: s.lat,
      lon: s.lon,
      valueUsvH: s.usvPerHour,
      unit: 'µSv/h',
      capturedAt: typeof s.time === 'string' ? s.time : null,
    });
  }
  return {
    points,
    generatedAt: payload.generatedAt ?? null,
    stale: payload.stale ?? false,
    unavailable: payload.unavailable ?? false,
    reason: payload.reason ?? payload.detail ?? null,
  };
}
