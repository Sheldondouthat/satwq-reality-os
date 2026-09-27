/**
 * NHC hurricane forecast cones (F9) — fetch /api/cyclones, render cone polygons.
 *
 * The /api/cyclones proxy already attaches the official NHC GIS forecast-cone
 * geometry (GIS layer id 7) to each storm (`storm.cone`, GeoJSON Polygon /
 * MultiPolygon) together with `geometryStatus`. This module validates just
 * that contract and renders it — it deliberately does NOT re-implement
 * attachCycloneGeometry (server/providers/cyclones.js), which operates on
 * the raw upstream GIS collections, not on the API response.
 *
 * Existing note: src/layers/cyclones/ already renders cones with advisory
 * selection; this forecast layer is the lightweight companion (cones only,
 * one labeled entity per storm) for the F9 forecast panel.
 */
import * as Cesium from 'cesium';

export const CONES_API_PATH = '/api/cyclones';
const RESPONSE_LIMIT = 4 * 1024 * 1024;
const MAX_STORMS = 32;
const MAX_COORDS = 25_000;

const malformed = () => new Error('Malformed cyclone snapshot');

const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

function position(value) {
  if (!value || !isFiniteNumber(value.longitude) || !isFiniteNumber(value.latitude))
    throw malformed();
  if (Math.abs(value.longitude) > 180 || Math.abs(value.latitude) > 90)
    throw malformed();
  return { longitude: value.longitude, latitude: value.latitude };
}

/** Bounded GeoJSON cone validation: Polygon/MultiPolygon of closed rings. */
export function validateConeGeometry(value, budget) {
  if (value === null) return null;
  if (!['Polygon', 'MultiPolygon'].includes(value?.type)) throw malformed();
  const point = (pair) => {
    if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(isFiniteNumber))
      throw malformed();
    if (Math.abs(pair[0]) > 180 || Math.abs(pair[1]) > 90) throw malformed();
    if (++budget.count > MAX_COORDS) throw malformed();
    return [pair[0], pair[1]];
  };
  const ring = (pairs) => {
    if (!Array.isArray(pairs) || pairs.length < 4 || pairs.length > 10_000)
      throw malformed();
    const result = pairs.map(point);
    const [f, l] = [result[0], result.at(-1)];
    if (f[0] !== l[0] || f[1] !== l[1]) throw malformed();
    return result;
  };
  const polygon = (rings) => {
    if (!Array.isArray(rings) || !rings.length || rings.length > 128)
      throw malformed();
    return rings.map(ring);
  };
  const coordinates =
    value.type === 'Polygon'
      ? polygon(value.coordinates)
      : value.coordinates.length > 32
        ? (() => { throw malformed(); })()
        : value.coordinates.map(polygon);
  return { type: value.type, coordinates };
}

const text = (value, max = 80) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw malformed();
  return value.trim();
};

/**
 * Project the /api/cyclones response down to renderable cone storms.
 * Storms whose geometry is not 'current' are skipped (never relabeled).
 */
export function parseConeStorms(payload) {
  if (!payload || !Array.isArray(payload.storms) || payload.storms.length > MAX_STORMS)
    throw malformed();
  if (payload.unavailable) return { storms: [], unavailable: true, reason: payload.reason ?? null };
  const budget = { count: 0 };
  const storms = [];
  for (const raw of payload.storms) {
    if (!/^(?:al|ep|cp)\d{6}$/.test(raw?.id)) throw malformed();
    if (raw.geometryStatus !== 'current') continue; // stale/pending geometry: skip, don't guess
    const cone = validateConeGeometry(raw.cone, budget);
    if (!cone) continue;
    storms.push({
      id: raw.id,
      name: text(raw.name),
      classification: typeof raw.classification === 'string' ? raw.classification.slice(0, 16) : '',
      position: position(raw.position),
      advisoryNumber: typeof raw.advisoryNumber === 'string' ? raw.advisoryNumber : '?',
      cone,
    });
  }
  return { storms, unavailable: false, reason: null };
}

/** Same-origin acquisition with a bounded body and timeout. */
export function createConeSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
  timeoutMs = 15_000,
} = {}) {
  return {
    async getSnapshot({ signal } = {}) {
      const controller = new AbortController();
      const abort = () => controller.abort(signal?.reason);
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(
        () => controller.abort(new Error('Cone request timed out')),
        timeoutMs,
      );
      try {
        signal?.throwIfAborted();
        const response = await fetchImpl(CONES_API_PATH, {
          signal: controller.signal,
          cache: 'no-store',
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new Error(`Cone HTTP ${response.status}`);
        }
        const raw = await response.text();
        if (raw.length > RESPONSE_LIMIT) throw new Error('Cone response too large');
        controller.signal.throwIfAborted();
        return parseConeStorms(JSON.parse(raw));
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}

export const CONE_FILL = '#7fe6ed';
const CONE_ALPHA = 0.28;

/** One labeled Cesium entity per storm: cone polygon + position point. */
export function coneStormEntity(storm, { cesium = Cesium } = {}) {
  const toHierarchy = (polygon) => {
    const [outer, ...holes] = polygon;
    const ring = (pts) => pts.map(([lon, lat]) => cesium.Cartesian3.fromDegrees(lon, lat));
    return new cesium.PolygonHierarchy(
      ring(outer),
      holes.map((h) => new cesium.PolygonHierarchy(ring(h))),
    );
  };
  const hierarchies =
    storm.cone.type === 'Polygon'
      ? [toHierarchy(storm.cone.coordinates)]
      : storm.cone.coordinates.map(toHierarchy);
  const fill = cesium.Color.fromCssColorString(CONE_FILL).withAlpha(CONE_ALPHA);
  const line = cesium.Color.fromCssColorString(CONE_FILL).withAlpha(0.9);
  return new cesium.Entity({
    id: `forecast-cone:${storm.id}`,
    position: cesium.Cartesian3.fromDegrees(storm.position.longitude, storm.position.latitude),
    polygon: {
      hierarchy: new cesium.PolygonHierarchy(
        hierarchies.flatMap((h) => h.positions),
        hierarchies.flatMap((h) => h.holes),
      ),
      material: new cesium.ColorMaterialProperty(fill),
    },
    polyline: {
      positions: hierarchies[0].positions,
      clampToGround: true,
      width: 2,
      material: new cesium.ColorMaterialProperty(line),
    },
    point: {
      pixelSize: 8,
      color: new cesium.ConstantProperty(
        cesium.Color.fromCssColorString(CONE_FILL).withAlpha(1),
      ),
      outlineColor: cesium.Color.BLACK,
      outlineWidth: 1,
    },
    label: {
      text: `${storm.name} · ${storm.classification} · Adv ${storm.advisoryNumber}`,
      font: '13px sans-serif',
      fillColor: cesium.Color.WHITE,
      outlineColor: cesium.Color.BLACK,
      outlineWidth: 2,
      style: cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new cesium.Cartesian2(0, -18),
      showBackground: true,
      backgroundColor: cesium.Color.BLACK.withAlpha(0.45),
    },
    description: `NHC forecast cone — center-track uncertainty, not the hazard area. Advisory ${storm.advisoryNumber}.`,
  });
}
