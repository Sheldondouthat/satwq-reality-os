/**
 * F3 — Seismic wavefronts: pure math for live P/S-wave rings.
 *
 * Given a quake's origin time, the P-wave front (~8 km/s) and S-wave front
 * (~4.5 km/s) radii grow linearly until the wavefront expires (default TTL
 * 30 min, by which time the P front has crossed 14,400 km). All functions
 * are pure and take an explicit clock so tests freeze time.
 */

/** P-wave speed through the crust/upper mantle (km/s). */
export const P_WAVE_KM_S = 8.0;
/** S-wave speed (km/s). */
export const S_WAVE_KM_S = 4.5;
/** Ring lifetime: older quakes auto-expire. */
export const WAVEFRONT_TTL_MS = 30 * 60 * 1000;
/** Half Earth's circumference — sanity cap for ring radii. */
export const EARTH_HALF_CIRCUMFERENCE_KM = 20015;
/** Max quakes rendered (most recent, most significant first). */
export const WAVEFRONT_QUAKE_LIMIT = 8;
/** USGS feed floor: the 4.5+ day feed only carries mag >= 4.5. */
export const WAVEFRONT_MIN_MAG = 4.5;

/**
 * Live wavefront radii for a quake at a frozen clock.
 * Returns `{ ageSec, pKm, sKm, expired }`.
 */
export function wavefrontRadii(
  originTimeMs,
  nowMs = Date.now(),
  ttlMs = WAVEFRONT_TTL_MS,
) {
  if (!Number.isFinite(originTimeMs) || !Number.isFinite(nowMs))
    throw new TypeError('wavefrontRadii needs finite originTimeMs and nowMs');
  const ageSec = Math.max(0, (nowMs - originTimeMs) / 1000);
  const expired = nowMs - originTimeMs > ttlMs;
  return {
    ageSec,
    pKm: Math.min(ageSec * P_WAVE_KM_S, EARTH_HALF_CIRCUMFERENCE_KM),
    sKm: Math.min(ageSec * S_WAVE_KM_S, EARTH_HALF_CIRCUMFERENCE_KM),
    expired,
  };
}

export function isWavefrontExpired(
  originTimeMs,
  nowMs = Date.now(),
  ttlMs = WAVEFRONT_TTL_MS,
) {
  if (!Number.isFinite(originTimeMs) || !Number.isFinite(nowMs)) return true;
  return nowMs - originTimeMs > ttlMs;
}

/**
 * Ring opacity fades from `maxAlpha` at t=0 to `minAlpha` at TTL.
 * Pure linear fade; clamped.
 */
export function wavefrontAlpha(
  ageSec,
  { ttlSec = WAVEFRONT_TTL_MS / 1000, maxAlpha = 0.95, minAlpha = 0.06 } = {},
) {
  const t = Math.min(1, Math.max(0, ageSec / ttlSec));
  return maxAlpha + (minAlpha - maxAlpha) * t;
}

/**
 * Normalize one USGS GeoJSON feature to a wavefront quake.
 * Returns null when the feature lacks usable geometry/time.
 */
export function normalizeQuakeFeature(feature) {
  try {
    const props = feature?.properties;
    const coords = feature?.geometry?.coordinates;
    if (!props || !Array.isArray(coords)) return null;
    const [lon, lat, depthKm] = coords;
    const originTimeMs = Number(props.time);
    const mag = Number(props.mag);
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      !Number.isFinite(originTimeMs) ||
      !Number.isFinite(mag)
    )
      return null;
    return {
      id: String(feature.id ?? props.code ?? `${lon},${lat},${originTimeMs}`),
      lon,
      lat,
      depthKm: Number.isFinite(Number(depthKm)) ? Number(depthKm) : null,
      mag,
      place: typeof props.place === 'string' ? props.place : null,
      originTimeMs,
      url: typeof props.url === 'string' ? props.url : null,
    };
  } catch {
    return null;
  }
}

/**
 * Pick the N most recent significant quakes: mag >= minMag, newest first.
 * Ties on time break toward higher magnitude.
 */
export function pickSignificantQuakes(
  rows,
  { limit = WAVEFRONT_QUAKE_LIMIT, minMag = WAVEFRONT_MIN_MAG } = {},
) {
  if (!Array.isArray(rows)) return [];
  return rows
    .filter(
      (q) =>
        q &&
        Number.isFinite(q.mag) &&
        q.mag >= minMag &&
        Number.isFinite(q.originTimeMs),
    )
    .sort((a, b) => b.originTimeMs - a.originTimeMs || b.mag - a.mag)
    .slice(0, Math.max(0, Math.floor(limit)));
}
