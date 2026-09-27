/**
 * Precipitation composition for the water twin (Wave 3, Track 1c, item 1.10).
 *
 * Crosses the reservoir/river registry with live RainViewer radar frames:
 * the latest radar frame's tile URL template (a standard XYZ layer the globe
 * can consume directly) plus one pre-composed 256px tile per registry point
 * at the configured zoom.
 *
 * Physics honesty: radar reflectivity is an OBSERVATION of precipitation
 * that already fell — it is not a forecast and not a rain total. The UI must
 * label it as radar, never as predicted rain.
 *
 * RainViewer public API is keyless and free (non-commercial courtesy use).
 * Fetch is injected so tests never touch the network. This module runs in
 * the browser; it shares no imports with the Pages Functions bundle path.
 */
import { RESERVOIRS, RIVERS } from './registry.js';

export const RAINVIEWER_MAPS_URL = 'https://api.rainviewer.com/public/weather-maps.json';
export const RAINVIEWER_TILE_HOST = 'https://tilecache.rainviewer.com';
/** RainViewer color scheme 2 (universal blue), options 1_1 (smooth + snow color). */
export const RAINVIEWER_COLOR = 2;
export const RAINVIEWER_OPTIONS = '1_1';

/** Latest past radar frame ({ time, path }) or null when none is usable. */
export function selectLatestRadarFrame(payload) {
  const past = payload?.radar?.past;
  if (!Array.isArray(past)) return null;
  const frames = past.filter((f) => f && typeof f.path === 'string' && f.path && Number.isFinite(Number(f.time)));
  if (!frames.length) return null;
  const latest = frames[frames.length - 1];
  return { time: Number(latest.time), path: latest.path };
}

/** Single radar tile URL for a frame path. */
export function tileUrlForFrame(path, z, x, y) {
  return `${RAINVIEWER_TILE_HOST}${path}/256/${z}/${x}/${y}/${RAINVIEWER_COLOR}/${RAINVIEWER_OPTIONS}.png`;
}

/** XYZ tile-URL template for a frame path (globe imagery layers consume this directly). */
export function tileTemplateForFrame(path) {
  return `${RAINVIEWER_TILE_HOST}${path}/256/{z}/{x}/{y}/${RAINVIEWER_COLOR}/${RAINVIEWER_OPTIONS}.png`;
}

/** Web-mercator slippy-map tile containing (lon, lat) at zoom z. */
export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((Number(lon) + 180) / 360) * n);
  const rad = (Number(lat) * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return { x, y };
}

/**
 * Fetch the latest radar frame and compose precipitation state for every
 * registry point. Never throws — failure yields { available: false }.
 */
export async function fetchPrecipitation({ fetchImpl = fetch, zoom = 6 } = {}) {
  const points = [
    ...RESERVOIRS.map((r) => ({ key: r.id, name: r.name, kind: 'reservoir', lat: r.lat, lon: r.lon })),
    ...RIVERS.map((r) => ({ key: r.site, name: r.name, kind: 'river', lat: r.lat, lon: r.lon })),
  ];
  try {
    const res = await fetchImpl(RAINVIEWER_MAPS_URL, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`http_${res.status}`);
    const frame = selectLatestRadarFrame(await res.json());
    if (!frame) return { available: false, reason: 'no radar frames' };
    return {
      available: true,
      frameTime: frame.time, // unix seconds, UTC
      tileTemplate: tileTemplateForFrame(frame.path),
      points: points.map((p) => {
        const { x, y } = lonLatToTile(p.lon, p.lat, zoom);
        return { ...p, tileUrl: tileUrlForFrame(frame.path, zoom, x, y), tileZ: zoom, tileX: x, tileY: y };
      }),
      note: 'radar reflectivity — observed precipitation, not a forecast or rain total',
    };
  } catch (error) {
    return { available: false, reason: error?.message ?? 'fetch failed' };
  }
}
