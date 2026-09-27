/**
 * Radiation map client (wave3 sci-fi B #4) — pure helpers.
 *
 * Dose-band coloring and /api/radiation payload validation. Rendering lives
 * in index.js. Bands are display-only; they are not health advice.
 */

export const DOSE_BANDS = ['low', 'background', 'elevated', 'high', 'unknown'];

export const BAND_COLORS = {
  low: '#35e0ff',
  background: '#7dff6a',
  elevated: '#ffd21a',
  high: '#ff2d2d',
  unknown: '#9fb4dd',
};

/** µSv/h → display band. Background ~0.05–0.3; >1 is elevated. Display-only. */
export function doseBand(usvH) {
  if (!Number.isFinite(usvH)) return 'unknown';
  if (usvH < 0.1) return 'low';
  if (usvH < 0.3) return 'background';
  if (usvH < 1) return 'elevated';
  return 'high';
}

export const BAND_LABELS = {
  low: '< 0.10 µSv/h — low',
  background: '0.10–0.30 µSv/h — typical background',
  elevated: '0.30–1.0 µSv/h — elevated',
  high: '> 1.0 µSv/h — high (verify sensor)',
  unknown: 'no reading',
};

export function validateRadiationPayload(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, reason: 'not an object' };
  if (!Array.isArray(payload.points)) return { ok: false, reason: 'points missing' };
  for (let i = 0; i < payload.points.length; i += 1) {
    const p = payload.points[i];
    if (
      !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon) ||
      !Number.isFinite(p.valueUsvH) ||
      Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180
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
