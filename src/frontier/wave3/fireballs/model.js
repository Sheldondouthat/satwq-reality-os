/**
 * Fireball impacts (3.2) — pure model: no DOM, no Cesium, no network.
 * Works on normalized /api/fireballs events:
 * {id, dateUtc, energyKt, impactEnergyKt, lat, lon, altKm, velKms, recent}.
 */

export const FIREBALL_HONESTY =
  'US government sensor detections via NASA CNEOS. Energies are derived ' +
  'from optical/infrasound measurements with roughly factor-of-two ' +
  'uncertainty — treat every kiloton figure as an estimate, not a scale ' +
  'reading. Streaks are artistic descent markers at the reported location, ' +
  'not reconstructed trajectories (the sensors do not publish azimuth).';

/** Defensive coercion of a provider event. Null on garbage. */
export function coerceFireball(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const numOrNull = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lat = numOrNull(raw.lat);
  const lon = numOrNull(raw.lon);
  const energyKt = numOrNull(raw.energyKt);
  const timeMs = Date.parse(raw.dateUtc);
  if (lat === null || Math.abs(lat) > 90) return null;
  if (lon === null || Math.abs(lon) > 180) return null;
  if (energyKt === null || energyKt <= 0) return null;
  if (!Number.isFinite(timeMs)) return null;
  return {
    id: typeof raw.id === 'string' ? raw.id : `fb-${timeMs}`,
    dateUtc: new Date(timeMs).toISOString(),
    timeMs,
    energyKt,
    impactEnergyKt: numOrNull(raw.impactEnergyKt),
    lat,
    lon,
    altKm: numOrNull(raw.altKm),
    velKms: numOrNull(raw.velKms),
    recent: raw.recent === true,
  };
}

/** Energy class for styling. Thresholds in kilotons of TNT. */
export function energyClass(kt) {
  if (kt < 0.1) return { key: 'fizzle', label: 'sub-kiloton pop', color: '#9fd8ff' };
  if (kt < 1) return { key: 'boom', label: 'sub-kiloton blast', color: '#ffd166' };
  if (kt < 10) return { key: 'city', label: 'kiloton-class', color: '#ff9f5a' };
  return { key: 'monster', label: 'multi-kiloton impactor', color: '#ff5a5a' };
}

export function formatEnergy(kt) {
  if (kt >= 100) return `${Math.round(kt)} kt TNT`;
  if (kt >= 1) return `${kt.toFixed(1)} kt TNT`;
  return `${(kt * 1000).toFixed(0)} t TNT`;
}

/** Pixel size for the impact marker: log-scaled so monsters don't eat the globe. */
export function markerPixels(kt) {
  return Math.round(6 + 10 * Math.log10(1 + kt));
}

/**
 * Descent-streak positions for a recent fireball: a short near-vertical
 * streak from the reported peak-brightness altitude to the surface, with a
 * slight drift so it reads as motion, not a pole. Returns [lon,lat,heightM].
 * Honest: azimuth is unknown — this is a marker, not a trajectory.
 */
export function streakPositions(event, { segments = 12, driftDeg = 1.2 } = {}) {
  const topM = Math.max(15000, (event.altKm ?? 35) * 1000);
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments; // 0 = top of streak, 1 = surface
    out.push([
      event.lon + driftDeg * f * 0.4,
      event.lat - driftDeg * f * 0.25,
      topM * (1 - f),
    ]);
  }
  return out;
}

export function isRecent(event, nowMs = Date.now(), days = 30) {
  return nowMs - event.timeMs <= days * 86400_000;
}

/** Sort newest-first, monsters-first tiebreak for the highlight reel. */
export function highlightReel(events, limit = 8) {
  return [...events]
    .sort((a, b) => b.timeMs - a.timeMs || b.energyKt - a.energyKt)
    .slice(0, limit);
}
