/**
 * Pure helpers for the OSM 3D Buildings layer (zero-key photoreal fallback).
 *
 * The layer queries bounded building footprints through the app's existing
 * keyless `/api/overpass` proxy (no Cesium ion token, no Google key) and
 * extrudes them as Cesium polygon entities. Everything in this module is
 * DOM-free and Cesium-free so it can be unit-tested deterministically.
 */

export const OSM_BUILDINGS_LAYER_ID = 'osm-buildings-3d';
/** Periodic refresh cadence handed to the layer lifecycle manager. */
export const OSM_BUILDINGS_UPDATE_INTERVAL_MS = 45_000;
/** Above this camera altitude the viewport covers too much ground to extrude. */
export const OSM_BUILDINGS_MAX_CAMERA_ALTITUDE_M = 60_000;
/** Hard cap on extruded buildings per refresh (entity + Overpass cost bound). */
export const OSM_BUILDINGS_MAX_BUILDINGS = 1200;
/** Overpass `[timeout:]` for the building query (server cap is 30s). */
export const OSM_BUILDINGS_QUERY_TIMEOUT_SEC = 20;
/** Fallback height when a building has no height/levels tags. */
export const OSM_BUILDINGS_DEFAULT_HEIGHT_M = 10;
/** Assumed height of one `building:levels` storey. */
export const OSM_BUILDINGS_LEVEL_HEIGHT_M = 3.2;
/** Extrusion sanity bounds (antenna masts and data errors excluded). */
export const OSM_BUILDINGS_MIN_HEIGHT_M = 3;
export const OSM_BUILDINGS_MAX_HEIGHT_M = 300;
/** Viewport half-size bounds in degrees (bbox stays far under the 12° proxy cap). */
export const OSM_BUILDINGS_MIN_HALF_DEG = 0.004;
export const OSM_BUILDINGS_MAX_HALF_DEG = 0.15;

/**
 * Build a bbox-bounded Overpass QL query for building footprints.
 * Every selector carries the bbox, so the query passes the app's
 * Overpass proxy sanitizer without modification.
 * @param {number} south
 * @param {number} west
 * @param {number} north
 * @param {number} east
 * @param {{ timeoutSec?: number }} [options]
 * @returns {string}
 */
export function buildBuildingsQuery(south, west, north, east, options = {}) {
  const timeoutSec = Number.isFinite(options.timeoutSec)
    ? Math.min(Math.max(1, Math.floor(options.timeoutSec)), 30)
    : OSM_BUILDINGS_QUERY_TIMEOUT_SEC;
  const bbox = [south, west, north, east]
    .map((value) => Number(value).toFixed(6))
    .join(',');
  return (
    `[out:json][timeout:${timeoutSec}];` +
    `(way["building"](${bbox}););` +
    `out geom qt ${OSM_BUILDINGS_MAX_BUILDINGS};`
  );
}

const HEIGHT_VALUE_RE = /(-?\d+(?:\.\d+)?)\s*(m|ft|feet)?/i;

/**
 * Estimate a building's extrusion height in metres from its OSM tags.
 * Prefers the explicit `height` tag, then `building:levels` × storey height,
 * then the conservative default. Always returns a finite, clamped value.
 * @param {Record<string, unknown>} [tags]
 * @returns {number}
 */
export function parseBuildingHeight(tags = {}) {
  const raw = tags?.height;
  if (typeof raw === 'string' || typeof raw === 'number') {
    const match = HEIGHT_VALUE_RE.exec(String(raw).trim());
    if (match) {
      let metres = Number.parseFloat(match[1]);
      const unit = (match[2] || 'm').toLowerCase();
      if (unit === 'ft' || unit === 'feet') metres *= 0.3048;
      if (Number.isFinite(metres) && metres > 0) {
        return clampHeight(metres);
      }
    }
  }
  const levels = Number.parseFloat(tags?.['building:levels']);
  if (Number.isFinite(levels) && levels > 0) {
    return clampHeight(levels * OSM_BUILDINGS_LEVEL_HEIGHT_M);
  }
  return OSM_BUILDINGS_DEFAULT_HEIGHT_M;
}

function clampHeight(metres) {
  return Math.min(
    OSM_BUILDINGS_MAX_HEIGHT_M,
    Math.max(OSM_BUILDINGS_MIN_HEIGHT_M, metres),
  );
}

/**
 * Convert a camera altitude into a viewport half-size in degrees.
 * @param {number} altitudeM
 * @returns {number}
 */
export function halfDegForAltitude(altitudeM) {
  const altitude = Number(altitudeM);
  if (!Number.isFinite(altitude) || altitude <= 0) {
    return OSM_BUILDINGS_MIN_HALF_DEG;
  }
  const halfDeg = (altitude * 1.2) / 111_320;
  return Math.min(
    OSM_BUILDINGS_MAX_HALF_DEG,
    Math.max(OSM_BUILDINGS_MIN_HALF_DEG, halfDeg),
  );
}

/**
 * Clamp a camera-centred viewport to valid geographic bounds.
 * @param {number} lat
 * @param {number} lon
 * @param {number} halfDeg
 * @returns {{ south: number, west: number, north: number, east: number }}
 */
export function clampViewBbox(lat, lon, halfDeg) {
  const half = Math.min(
    OSM_BUILDINGS_MAX_HALF_DEG,
    Math.max(OSM_BUILDINGS_MIN_HALF_DEG, Number(halfDeg) || 0),
  );
  const centerLat = Number.isFinite(lat) ? Math.max(-90, Math.min(90, lat)) : 0;
  const centerLon = Number.isFinite(lon)
    ? Math.max(-180, Math.min(180, lon))
    : 0;
  return {
    south: Math.max(-90, centerLat - half),
    north: Math.min(90, centerLat + half),
    west: Math.max(-180, centerLon - half),
    east: Math.min(180, centerLon + half),
  };
}

/**
 * Whether the layer should attempt a refresh at this camera altitude.
 * @param {number} altitudeM
 * @returns {boolean}
 */
export function shouldFetchForAltitude(altitudeM) {
  return (
    Number.isFinite(altitudeM) &&
    altitudeM > 0 &&
    altitudeM <= OSM_BUILDINGS_MAX_CAMERA_ALTITUDE_M
  );
}

/**
 * Parse an Overpass `out geom` response into extrusion-ready footprints.
 * Only closed ways with ≥3 distinct vertices survive; everything else
 * (relations, nodes, open ways, malformed entries) is dropped.
 * @param {unknown} json
 * @returns {Array<{ id: string, positions: Array<[number, number]>, height: number }>}
 */
export function parseBuildingsResponse(json) {
  const elements = json?.elements;
  if (!Array.isArray(elements)) return [];
  const footprints = [];
  for (const element of elements) {
    if (!element || element.type !== 'way') continue;
    const geometry = element.geometry;
    if (!Array.isArray(geometry) || geometry.length < 4) continue;
    const positions = [];
    const seen = new Set();
    for (const node of geometry) {
      const lat = Number(node?.lat);
      const lon = Number(node?.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      const key = `${lat.toFixed(7)},${lon.toFixed(7)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      positions.push([lon, lat]);
    }
    if (positions.length < 3) continue;
    footprints.push({
      id: `osm-building:${element.id}`,
      positions,
      height: parseBuildingHeight(element.tags),
    });
    if (footprints.length >= OSM_BUILDINGS_MAX_BUILDINGS) break;
  }
  return footprints;
}

/**
 * Flatten a footprint's positions for `Cartesian3.fromDegreesArray`.
 * @param {Array<[number, number]>} positions
 * @returns {number[]}
 */
export function flattenFootprintPositions(positions) {
  return positions.flat();
}
