import * as Cesium from 'cesium';
export const BUOY_OVERLAY_SOURCE_ID = 'buoys';
export const BUOY_OVERLAY_COHORT_LIMIT = 48;
export const BUOY_OVERLAY_COLLISION_CAPACITY = 24;

export function buoyColor() {
  return Cesium.Color.AQUA;
}

/**
 * Build the source-owned presentation for one buoy label.
 * @param {object} input
 * @param {string} input.id Buoy station id.
 * @param {Cesium.Cartesian3} input.position Ground anchor.
 * @param {string} input.name Station name.
 * @param {string} input.type Station type (buoy, ship, platform…).
 * @param {string} input.accent Source-owned buoy color.
 */
export function createBuoyOverlayEntry({ id, position, name, type, accent }) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: String(id),
    subtitle: type ? `${name} · ${type}` : String(name),
    accent,
  };
}

/** Take a deterministic spatial sample so labels stay readable. */
export function selectBuoyOverlayCohort(
  entries,
  limit = BUOY_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(1, Math.floor(limit));
  if (entries.length <= cap) return entries.slice();
  const step = entries.length / cap;
  const picked = [];
  for (let i = 0; i < cap; i++) picked.push(entries[Math.floor(i * step)]);
  return picked;
}

export function mapAnalystRecord(raw, index = 0) {
  return {
    id: `buoy-${index}`,
    type: 'buoy',
    stationId: raw.id ?? null,
    name: raw.name ?? null,
    stationType: raw.type ?? null,
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
  };
}
