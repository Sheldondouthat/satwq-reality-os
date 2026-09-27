import * as Cesium from 'cesium';
export const AURORA_OVERLAY_SOURCE_ID = 'aurora';
export const AURORA_OVERLAY_COHORT_LIMIT = 8;
export const AURORA_OVERLAY_COLLISION_CAPACITY = 4;

/** Approximate centered-dipole north magnetic pole (degrees). */
export const MAGNETIC_NORTH_POLE = Object.freeze({ lat: 80.65, lon: -72.68 });

/** NOAA G-scale description for a Kp value. */
export function kpToGScale(kp) {
  if (kp >= 9) return 'G5 · Extreme';
  if (kp >= 8) return 'G4 · Severe';
  if (kp >= 7) return 'G3 · Strong';
  if (kp >= 6) return 'G2 · Moderate';
  if (kp >= 5) return 'G1 · Minor';
  return 'G0 · Quiet';
}

export function kpColor(kp) {
  if (kp >= 7) return Cesium.Color.RED;
  if (kp >= 5) return Cesium.Color.ORANGE;
  if (kp >= 3) return Cesium.Color.YELLOW;
  return Cesium.Color.LIMEGREEN;
}

/**
 * Equatorward boundary of the auroral oval in magnetic latitude.
 * Rule of thumb: the oval expands ~2° equatorward per Kp unit from 67°.
 */
export function ovalBoundaryMagLat(kp) {
  return Math.min(67, Math.max(50, 67 - 2 * kp));
}

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const normLon = (lon) => ((lon + 540) % 360) - 180;

/**
 * Ring of [lon, lat] points tracing the auroral oval boundary around the
 * magnetic north pole. Pure spherical math — no Cesium dependency.
 */
export function ovalRingPositions(kp, segments = 72) {
  const boundary = ovalBoundaryMagLat(kp);
  const angularRadius = rad(90 - boundary);
  const lat1 = rad(MAGNETIC_NORTH_POLE.lat);
  const lon1 = rad(MAGNETIC_NORTH_POLE.lon);
  const ring = [];
  const steps = Math.max(8, Math.floor(segments));
  for (let i = 0; i < steps; i++) {
    const brg = rad((i / steps) * 360);
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(angularRadius) +
        Math.cos(lat1) * Math.sin(angularRadius) * Math.cos(brg),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brg) * Math.sin(angularRadius) * Math.cos(lat1),
        Math.cos(angularRadius) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([normLon(deg(lon2)), deg(lat2)]);
  }
  return ring;
}

export function createAuroraOverlayEntry({ id, position, kp, accent }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: `Kp ${Number(kp).toFixed(1)}`,
    subtitle: kpToGScale(kp),
    accent,
  };
}

export function mapAnalystRecord(raw, index = 0) {
  return {
    id: `aurora-${index}`,
    type: 'aurora',
    kp: raw.kp ?? null,
    gScale: raw.kp != null ? kpToGScale(raw.kp) : null,
    timeMs: raw.timeMs ?? null,
  };
}
