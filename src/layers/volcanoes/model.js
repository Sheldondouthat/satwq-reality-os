import * as Cesium from 'cesium';
export const VOLCANO_OVERLAY_SOURCE_ID = 'volcanoes';
export const VOLCANO_OVERLAY_COHORT_LIMIT = 64;
export const VOLCANO_OVERLAY_COLLISION_CAPACITY = 32;

/**
 * Color by USGS aviation color code:
 *  - RED: Red — eruption underway
 *  - ORANGE: Orange — heightened unrest
 *  - YELLOW: Yellow — signs of unrest
 *  - GREEN: Green — normal
 *  - UNASSIGNED/unknown: Gray
 */
export function colorCodeColor(code) {
  switch (String(code).toUpperCase()) {
    case 'RED':
      return Cesium.Color.RED;
    case 'ORANGE':
      return Cesium.Color.ORANGE;
    case 'YELLOW':
      return Cesium.Color.YELLOW;
    case 'GREEN':
      return Cesium.Color.LIMEGREEN;
    default:
      return Cesium.Color.GRAY;
  }
}

/** Elevated means the volcano is at YELLOW/ORANGE/RED — worth a bigger marker. */
export function isElevated(code) {
  const upper = String(code).toUpperCase();
  return upper === 'RED' || upper === 'ORANGE' || upper === 'YELLOW';
}

/**
 * Build the source-owned presentation for one volcano label.
 * @param {object} input
 * @param {string} input.id Stable volcano id (GVP volcano number).
 * @param {Cesium.Cartesian3} input.position Ground anchor shared with the marker.
 * @param {string} input.name Volcano name.
 * @param {string} input.colorCode Aviation color code.
 * @param {string} input.alertLevel USGS alert level.
 * @param {string} input.accent Source-owned color-code color.
 */
export function createVolcanoOverlayEntry({
  id,
  position,
  name,
  colorCode,
  alertLevel,
  accent,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title: String(name),
    subtitle: `${colorCode} · ${alertLevel}`,
    accent,
    colorCode: String(colorCode).toUpperCase(),
  };
}

/**
 * Elevated volcanoes sort first so they win label collisions; the rest fill
 * the remaining cohort budget.
 */
export function selectVolcanoOverlayCohort(
  entries,
  limit = VOLCANO_OVERLAY_COHORT_LIMIT,
) {
  const elevated = [];
  const rest = [];
  for (const entry of entries) {
    (isElevated(entry.colorCode) ? elevated : rest).push(entry);
  }
  return [...elevated, ...rest].slice(0, Math.max(0, limit));
}

export function mapAnalystRecord(raw, index = 0) {
  return {
    id: `volcano-${index}`,
    type: 'volcano',
    name: raw.name ?? null,
    colorCode: raw.colorCode ?? null,
    alertLevel: raw.alertLevel ?? null,
    lat: raw.lat ?? null,
    lon: raw.lon ?? null,
  };
}
