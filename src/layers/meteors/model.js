import * as Cesium from 'cesium';
export const METEOR_OVERLAY_SOURCE_ID = 'meteors';
export const METEOR_OVERLAY_COHORT_LIMIT = 16;
export const METEOR_OVERLAY_COLLISION_CAPACITY = 8;

const normLon = (lon) => ((lon + 540) % 360) - 180;

/** Greenwich Mean Sidereal Time in degrees for a date (IAU 1982). */
export function gmstDeg(date) {
  const jd = date.getTime() / 86400000 + 2440587.5;
  const d = jd - 2451545.0;
  return (((280.46061837 + 360.98564736629 * d) % 360) + 360) % 360;
}

/**
 * Sub-observer point: where on Earth the shower radiant is at the zenith
 * right now. Pure astronomy math — no network, no Cesium.
 */
export function radiantSubpoint(raHours, decDeg, date) {
  const lst = gmstDeg(date);
  return { lat: decDeg, lon: normLon(raHours * 15 - lst) };
}

export function meteorColor(zhr) {
  if (zhr >= 100) return Cesium.Color.GOLD;
  if (zhr >= 40) return Cesium.Color.WHITE;
  return Cesium.Color.LIGHTSKYBLUE;
}

const monthName = (m) =>
  [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ][m - 1];

/**
 * Build the source-owned presentation for one active shower.
 * @param {object} input
 * @param {string} input.id Stable shower id.
 * @param {Cesium.Cartesian3} input.position Radiant subpoint anchor.
 * @param {object} input.shower Shower table row.
 * @param {string} input.accent Source-owned ZHR color.
 */
export function createMeteorOverlayEntry({ id, position, shower, accent }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: `${shower.name} ☄`,
    subtitle: `ZHR ${shower.zhr} · peak ${monthName(shower.peakMonth)} ${shower.peakDay}`,
    accent,
  };
}

export function mapAnalystRecord(raw, index = 0) {
  return {
    id: `meteor-${index}`,
    type: 'meteor-shower',
    name: raw.name ?? null,
    zhr: raw.zhr ?? null,
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
  };
}
