/**
 * Product configurations and snapshot sources for the keyless tile-imagery
 * layers. All sources are keyless; no fake data is ever produced — sources
 * throw when the upstream feed is malformed or a product is unavailable.
 */

export const GIBS_WMTS_BASE =
  'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
/** Verified 2026-09-27: responds with `access-control-allow-origin: *`, so the
 * browser fetches it directly with no proxy. */
export const RAINVIEWER_API_URL =
  'https://api.rainviewer.com/public/weather-maps.json';

export const GIBS_CREDIT =
  'Imagery: We acknowledge the use of imagery provided by services from ' +
  "NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth " +
  'Science Data and Information System (ESDIS)';
export const RAINVIEWER_CREDIT =
  'Radar & satellite: ' +
  '<a href="https://www.rainviewer.com/" target="_blank" rel="noopener">RainViewer</a>';

const SIX_HOURS_MS = 6 * 3600 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Yesterday in UTC as YYYY-MM-DD — the GIBS "best" daily layers lag ~1 day. */
export function yesterdayDateUTC(nowMs = Date.now()) {
  const date = new Date(nowMs);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

/**
 * Verified GIBS WMTS REST pattern (epsg3857/best, WebMercator — matches
 * Cesium's default UrlTemplateImageryProvider tiling):
 *   {BASE}/{LAYER}/default/{DATE}/{MATRIXSET}/{z}/{y}/{x}.{ext}
 */
export function gibsTileTemplate({ layerName, matrixSet, ext, date }) {
  if (!layerName || !matrixSet || !ext || !/^\d{4}-\d{2}-\d{2}$/.test(date || ''))
    throw new TypeError('gibsTileTemplate requires layerName, matrixSet, ext, date');
  return `${GIBS_WMTS_BASE}/${layerName}/default/${date}/${matrixSet}/{z}/{y}/{x}.${ext}`;
}

/**
 * Snapshot source for a NASA GIBS daily (or fixed-date) layer. The template is
 * recomputed on every snapshot so the date rolls over at UTC midnight.
 */
export function createGibsSource(
  product,
  { now = () => Date.now() } = {},
) {
  if (!product?.wmtsLayer)
    throw new TypeError('createGibsSource requires a GIBS product config');
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const date = product.fixedDate || yesterdayDateUTC(now());
      return {
        template: gibsTileTemplate({
          layerName: product.wmtsLayer,
          matrixSet: product.matrixSet,
          ext: product.ext,
          date,
        }),
        date,
        maximumLevel: product.maximumLevel,
        credit: GIBS_CREDIT,
        timeMs: Date.parse(`${date}T00:00:00Z`),
      };
    },
  };
}

/** GIBS product configurations (4 of the 6 tile-imagery layers). */
export const GIBS_PRODUCTS = Object.freeze({
  truecolor: Object.freeze({
    id: 'gibs-truecolor',
    name: 'NASA True Color',
    icon: '🛰️',
    sourceLabel: 'NASA GIBS',
    wmtsLayer: 'MODIS_Terra_CorrectedReflectance_TrueColor',
    matrixSet: 'GoogleMapsCompatible_Level9',
    ext: 'jpg',
    maximumLevel: 9,
    updateInterval: SIX_HOURS_MS,
  }),
  nightlights: Object.freeze({
    id: 'gibs-nightlights',
    name: 'Black Marble Night Lights',
    icon: '🌃',
    sourceLabel: 'NASA GIBS',
    wmtsLayer: 'VIIRS_Black_Marble',
    matrixSet: 'GoogleMapsCompatible_Level8',
    ext: 'png',
    fixedDate: '2016-01-01',
    maximumLevel: 8,
    updateInterval: SIX_HOURS_MS,
  }),
  chlorophyll: Object.freeze({
    id: 'gibs-chlorophyll',
    name: 'Ocean Chlorophyll',
    icon: '🌊',
    sourceLabel: 'NASA GIBS',
    wmtsLayer: 'VIIRS_SNPP_L2_Chlorophyll_A',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    updateInterval: SIX_HOURS_MS,
  }),
  sst: Object.freeze({
    id: 'gibs-sst',
    name: 'Sea Surface Temp',
    icon: '🌡️',
    sourceLabel: 'NASA GIBS',
    wmtsLayer: 'GHRSST_L4_MUR_Sea_Surface_Temperature',
    matrixSet: 'GoogleMapsCompatible_Level7',
    ext: 'png',
    maximumLevel: 7,
    updateInterval: SIX_HOURS_MS,
  }),
});

/** RainViewer product configurations (2 of the 6 tile-imagery layers). */
export const RAINVIEWER_PRODUCTS = Object.freeze({
  radar: Object.freeze({
    id: 'rainviewer-radar',
    name: 'RainViewer Radar',
    icon: '🌧️',
    sourceLabel: 'RainViewer',
    kind: 'radar',
    maximumLevel: 12,
    updateInterval: TEN_MINUTES_MS,
  }),
  satellite: Object.freeze({
    id: 'rainviewer-satellite',
    name: 'RainViewer Satellite IR',
    icon: '📡',
    sourceLabel: 'RainViewer',
    kind: 'satellite',
    maximumLevel: 10,
    updateInterval: TEN_MINUTES_MS,
  }),
});

/** Static template for a GIBS product, or null for frame-driven products. */
export function productUrlTemplate(product, nowMs = Date.now()) {
  if (!product?.wmtsLayer) return null;
  return gibsTileTemplate({
    layerName: product.wmtsLayer,
    matrixSet: product.matrixSet,
    ext: product.ext,
    date: product.fixedDate || yesterdayDateUTC(nowMs),
  });
}

function validRainViewerFrame(frame) {
  return (
    frame &&
    Number.isFinite(Number(frame.time)) &&
    typeof frame.path === 'string' &&
    frame.path.startsWith('/')
  );
}

/**
 * Validate the RainViewer weather-maps.json payload and pick the latest frame.
 * Returns `{ ok: true, snapshot }` or `{ ok: false, error, unavailable? }`.
 * An empty infrared array is a real, expected upstream state — reported as
 * `unavailable` (not malformed) so the layer degrades cleanly.
 */
export function normalizeRainViewerSnapshot(payload, kind) {
  if (!payload || typeof payload !== 'object')
    return { ok: false, error: 'Malformed RainViewer response' };
  const host =
    typeof payload.host === 'string' ? payload.host.replace(/\/+$/, '') : '';
  if (!/^https:\/\//.test(host))
    return { ok: false, error: 'Malformed RainViewer response: bad host' };
  const frames =
    kind === 'radar'
      ? payload.radar?.past
      : kind === 'satellite'
        ? payload.satellite?.infrared
        : null;
  if (kind !== 'radar' && kind !== 'satellite')
    return { ok: false, error: `Unknown RainViewer kind: ${kind}` };
  if (!Array.isArray(frames) || frames.length === 0)
    return {
      ok: false,
      error:
        kind === 'radar'
          ? 'RainViewer radar feed empty'
          : 'RainViewer satellite infrared feed empty',
      unavailable: kind === 'satellite',
    };
  const valid = frames
    .filter(validRainViewerFrame)
    .sort((a, b) => Number(b.time) - Number(a.time));
  if (valid.length === 0)
    return { ok: false, error: 'Malformed RainViewer response: no valid frames' };
  const frame = valid[0];
  return {
    ok: true,
    snapshot: {
      // Verified RainViewer tile pattern: {host}{path}/256/{z}/{x}/{y}/2/1_1.png
      template: `${host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`,
      frameTimeMs: Number(frame.time) * 1000,
      maximumLevel:
        kind === 'radar'
          ? RAINVIEWER_PRODUCTS.radar.maximumLevel
          : RAINVIEWER_PRODUCTS.satellite.maximumLevel,
      credit: RAINVIEWER_CREDIT,
      timeMs: Number(frame.time) * 1000,
    },
  };
}

/**
 * Snapshot source for a RainViewer product. Throws on HTTP errors, malformed
 * payloads, and unavailable products (satellite infrared empty) — never
 * returns fake frames.
 */
export function createRainViewerSource({
  kind,
  fetchImpl = (...args) => globalThis.fetch(...args),
  apiUrl = RAINVIEWER_API_URL,
} = {}) {
  if (kind !== 'radar' && kind !== 'satellite')
    throw new TypeError("RainViewer source kind must be 'radar' or 'satellite'");
  return {
    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const response = await fetchImpl(apiUrl, { signal });
      if (!response.ok) throw new Error(`RainViewer HTTP ${response.status}`);
      const payload = await response.json();
      signal?.throwIfAborted();
      const parsed = normalizeRainViewerSnapshot(payload, kind);
      if (!parsed.ok) {
        const error = new Error(parsed.error);
        error.unavailable = Boolean(parsed.unavailable);
        throw error;
      }
      return parsed.snapshot;
    },
  };
}
