/**
 * Low-precision solar ephemeris. Pure math — no network, no Cesium.
 * Accuracy is ~0.01° for the subsolar point, more than enough for display.
 */

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const norm360 = (x) => ((x % 360) + 360) % 360;
const normLon = (lon) => ((lon + 540) % 360) - 180;

/** Greenwich Mean Sidereal Time in degrees for a Date. */
export function gmstDeg(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  return norm360(280.46061837 + 360.98564736629 * (jd - 2451545));
}

/**
 * Subsolar point for a Date: { lat, lon } in degrees.
 * Standard low-precision solar coordinates (mean longitude + anomaly).
 */
export function subsolarPoint(date) {
  const d = (date.getTime() - Date.UTC(2000, 0, 1, 12, 0, 0)) / 86400000;
  const L = norm360(280.46 + 0.9856474 * d); // mean longitude
  const g = norm360(357.528 + 0.9856003 * d); // mean anomaly
  const lambda = L + 1.915 * Math.sin(g * RAD) + 0.02 * Math.sin(2 * g * RAD);
  const eps = 23.439 - 0.0000004 * d; // obliquity
  const ra =
    Math.atan2(
      Math.cos(eps * RAD) * Math.sin(lambda * RAD),
      Math.cos(lambda * RAD),
    ) * DEG;
  const dec = Math.asin(Math.sin(eps * RAD) * Math.sin(lambda * RAD)) * DEG;
  return { lat: dec, lon: normLon(ra - gmstDeg(date)) };
}

/** Antisolar point (center of the night hemisphere). */
export function antisolarPoint(date) {
  const sub = subsolarPoint(date);
  return { lat: -sub.lat, lon: normLon(sub.lon + 180) };
}

/**
 * Ring of [lon, lat] points at a fixed angular distance from a center point.
 * Uses the great-circle destination-point formula.
 */
export function ringAroundPoint(
  centerLat,
  centerLon,
  angularRadiusDeg,
  segments = 180,
) {
  const lat1 = centerLat * RAD;
  const lon1 = centerLon * RAD;
  const ang = angularRadiusDeg * RAD;
  const steps = Math.max(8, Math.floor(segments));
  const ring = [];
  for (let i = 0; i < steps; i++) {
    const brg = (i / steps) * 360 * RAD;
    const lat2 = Math.asin(
      Math.sin(lat1) * Math.cos(ang) +
        Math.cos(lat1) * Math.sin(ang) * Math.cos(brg),
    );
    const lon2 =
      lon1 +
      Math.atan2(
        Math.sin(brg) * Math.sin(ang) * Math.cos(lat1),
        Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2),
      );
    ring.push([normLon(lon2 * DEG), lat2 * DEG]);
  }
  return ring;
}

/** Day/night terminator: the 90° great circle around the subsolar point. */
export function terminatorRing(date, segments = 180) {
  const sub = subsolarPoint(date);
  return ringAroundPoint(sub.lat, sub.lon, 90, segments);
}

/** Night-side cap boundary: the 90° great circle around the antisolar point. */
export function nightCapRing(date, segments = 180) {
  const anti = antisolarPoint(date);
  return ringAroundPoint(anti.lat, anti.lon, 90, segments);
}

/** Angular distance in degrees between two [lon, lat] points. */
export function angularDistance([lon1, lat1], [lon2, lat2]) {
  const a = Math.sin(lat1 * RAD) * Math.sin(lat2 * RAD);
  const b =
    Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.cos((lon2 - lon1) * RAD);
  return Math.acos(Math.min(1, Math.max(-1, a + b))) * DEG;
}
