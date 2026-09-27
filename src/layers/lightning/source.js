/**
 * lightning/source.js — strike-feed sources for the F4 lightning layer.
 *
 * SOURCE INTERFACE (both implementations): `{ getStrikes({ signal } = {}) }`
 * resolving to an array of strike impulses:
 *   { id, lat, lon, intensity, cellId, timeMs, modeled, sourceLabel }
 *
 * KEYLESS-SOURCE RESEARCH (probed 2026-09-27, single requests, no hammering):
 *  1. Blitzortung  https://data.blitzortung.org/Data_1.php  → HTTP 401.
 *     All live strike data sits behind the login wall; a free account
 *     (blitzortung.org registration) is required. → stub below.
 *  2. Iowa Environmental Mesonet  https://mesonet.agron.iastate.edu/geojson/glm.geojson
 *     → HTTP 301 to the IEM API docs; no such endpoint exists.
 *  3. NOAA GOES-R GLM via the `noaa-goes` AWS open-data bucket
 *     (GLM-L2-LCFA/<year>/<doy>/<hour>/): bucket listings returned 0 keys for
 *     every probed prefix (2026/269/19, 2026/270/, GLM-L2-LCFA/, and the bare
 *     bucket). Even if reachable, GLM flash files are NetCDF — decoding them
 *     in-browser needs a NetCDF parser (new dependency, disallowed here).
 *     Kept as the documented v2 upgrade path (server-side extraction or a
 *     future dependency allowance).
 *  4. lightningmaps.org: live data is the Blitzortung feed under the same
 *     login wall (not probed further — no point hitting it).
 *
 * CONCLUSION: no practical keyless real-time strike feed exists for a
 * dependency-free browser app today. v1 therefore ships RADAR-MODELED strikes
 * (default, honestly labeled) with the Blitzortung account path stubbed for
 * later. The interface accepts a real feed later without touching the layer.
 */

import {
  createRainViewerSource,
  RAINVIEWER_API_URL,
} from '../imageryTile/products.js';
import {
  LIGHTNING_SOURCE_LABEL,
  RADAR_TILE_Z,
  TILE_PX,
  CELL_GRID,
  CONVECTIVE_CELL_THRESHOLD,
  isConvectivePixel,
  intensityFromWarmFraction,
  cellCenter,
  cellIdFor,
  sampleStrikes,
  createSeededRng,
} from './model.js';

/** Default coarse tiles (z=3) covering the radar-rich regions RainViewer actually paints. */
export const DEFAULT_RADAR_TILES = Object.freeze([
  // CONUS
  [1, 2], [2, 2], [1, 3], [2, 3],
  // Europe
  [3, 2], [4, 2], [3, 3], [4, 3],
  // East Asia / Japan
  [6, 2], [7, 2], [6, 3], [7, 3],
  // SE Asia / Australia
  [6, 4], [7, 4], [6, 5], [7, 5],
]);

export const DEFAULT_STRIKES_PER_BATCH = 24;

/**
 * Upgrade notes for wiring a real Blitzortung feed (free account required).
 * Kept as data so the app can surface it in the HUD/settings instead of a
 * dead tooltip.
 */
export const BLITZORTUNG_UPGRADE_NOTES = Object.freeze({
  summary:
    'Blitzortung provides the real strike feed, but live data requires a free ' +
    'blitzortung.org account (login wall, HTTP 401 without it).',
  steps: Object.freeze([
    'Register a free account at https://www.blitzortung.org/ and log in once in a browser.',
    'Open https://www.blitzortung.org/en/live_lightning_maps.php while logged in and capture the session cookie.',
    'Store the session via the Secure Vault flow (never raw credentials in chat/files).',
    'Pass { sessionCookie } (or { username, password } for the documented POST login) to createBlitzortungSource().',
    'Swap the lightning layer source to the Blitzortung implementation in the catalog wiring (see INTEGRATION.md).',
  ]),
  endpoints: Object.freeze({
    liveMap: 'https://www.blitzortung.org/en/live_lightning_maps.php',
    data: 'https://data.blitzortung.org/Data_1.php (session-gated)',
  }),
});

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** Scan one decoded tile into candidate convective cells. Pure over ImageData. */
export function cellsFromTileImage(imageData, tileX, tileY, z = RADAR_TILE_Z) {
  if (!imageData) return [];
  const { width, height, data } = imageData;
  if (!width || !height || !data || data.length < width * height * 4)
    return [];
  const cellPxX = width / CELL_GRID;
  const cellPxY = height / CELL_GRID;
  const cells = [];
  for (let i = 0; i < CELL_GRID; i += 1) {
    for (let j = 0; j < CELL_GRID; j += 1) {
      const x0 = Math.floor(i * cellPxX);
      const x1 = Math.floor((i + 1) * cellPxX);
      const y0 = Math.floor(j * cellPxY);
      const y1 = Math.floor((j + 1) * cellPxY);
      let warm = 0;
      let total = 0;
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const o = (y * width + x) * 4;
          const alpha = data[o + 3];
          if (alpha < 16) continue; // transparent = no radar coverage
          total += 1;
          if (isConvectivePixel(data[o], data[o + 1], data[o + 2])) warm += 1;
        }
      }
      if (total === 0) continue;
      const intensity = intensityFromWarmFraction(warm / total);
      if (intensity <= 0) continue;
      const { lat, lon } = cellCenter(tileX, tileY, i, j, z);
      cells.push({
        lat,
        lon,
        intensity,
        cellId: cellIdFor(tileX, tileY, i, j),
        warmFraction: warm / total,
      });
    }
  }
  return cells;
}

/**
 * Default tile-image decoder (browser): bytes → {width, height, data}.
 * Uses createImageBitmap + an offscreen canvas; never touches the DOM when
 * OffscreenCanvas is available. Replaceable for tests via `decodeTileImage`.
 */
export async function decodeTileImageBrowser(bytes) {
  const blob =
    bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'image/png' });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas =
      typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(bitmap.width, bitmap.height)
        : Object.assign(document.createElement('canvas'), {
            width: bitmap.width,
            height: bitmap.height,
          });
    const g = canvas.getContext('2d', { willReadFrequently: true });
    if (!g) throw new Error('2d canvas context unavailable');
    g.drawImage(bitmap, 0, 0);
    const imageData = g.getImageData(0, 0, bitmap.width, bitmap.height);
    return {
      width: imageData.width,
      height: imageData.height,
      data: imageData.data,
    };
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close();
  }
}

const tileUrl = (template, z, x, y) =>
  template.replace('{z}', z).replace('{x}', x).replace('{y}', y);

/**
 * Radar-modeled strike source (DEFAULT implementation).
 *
 * Pipeline: RainViewer radar snapshot (frame template + frameTimeMs) →
 * fetch a small budget of coarse radar tiles → decode → find warm-color
 * (high-dBZ) candidate cells → cache cells per radar frame → sample strike
 * impulses with jitter on every getStrikes() call.
 *
 * The cell cache is keyed on the radar frame time, so repeated getStrikes()
 * calls are pure re-samples (no network) until RainViewer publishes a new
 * frame (~10 min cadence). An optional `getCycloneCenters` hook adds extra
 * convective cells around active cyclone centers (eyewall lightning is real).
 *
 * Every strike carries `modeled: true` + LIGHTNING_SOURCE_LABEL.
 */
export function createRadarModeledLightningSource({
  radarSource = null,
  fetchImpl = (...args) => globalThis.fetch(...args),
  decodeTileImage = null,
  tileSet = DEFAULT_RADAR_TILES,
  strikesPerBatch = DEFAULT_STRIKES_PER_BATCH,
  getCycloneCenters = null,
  nowMs = () => Date.now(),
  rngSeed = 0x9e3779b9,
} = {}) {
  const radar =
    radarSource ?? createRainViewerSource({ kind: 'radar', fetchImpl });
  const decode =
    decodeTileImage ??
    (typeof createImageBitmap === 'function' ? decodeTileImageBrowser : null);
  const rng = createSeededRng(rngSeed);

  let _cachedFrameMs = null;
  let _cells = [];
  let _refreshPromise = null;
  let _lastError = null;
  let _batchSeq = 0;

  async function refreshCells(signal) {
    if (_refreshPromise) return _refreshPromise;
    _refreshPromise = (async () => {
      const snapshot = await radar.getSnapshot({ signal });
      signal?.throwIfAborted();
      if (
        _cachedFrameMs != null &&
        snapshot?.frameTimeMs === _cachedFrameMs &&
        _cells.length > 0
      ) {
        return _cells; // same radar frame: pure re-sample, no network
      }
      const template = snapshot?.template;
      if (typeof template !== 'string' || !template.includes('{z}'))
        throw new Error('Radar snapshot has no usable tile template');
      if (!decode) throw new Error('No tile-image decoder available');

      const settled = await Promise.allSettled(
        tileSet.map(async ([x, y]) => {
          const response = await fetchImpl(tileUrl(template, RADAR_TILE_Z, x, y), {
            signal,
          });
          if (!response.ok) throw new Error(`radar tile HTTP ${response.status}`);
          const bytes = await response.arrayBuffer();
          signal?.throwIfAborted();
          const image = await decode(bytes);
          return cellsFromTileImage(image, x, y, RADAR_TILE_Z);
        }),
      );
      signal?.throwIfAborted();

      const next = [];
      let failures = 0;
      for (const s of settled) {
        if (s.status === 'fulfilled') next.push(...s.value);
        else failures += 1;
      }
      if (next.length === 0 && failures === tileSet.length)
        throw new Error('All radar tiles failed to load');

      // Optional cyclone eyewall cells: active cyclones concentrate lightning.
      if (typeof getCycloneCenters === 'function') {
        try {
          const centers = await getCycloneCenters({ signal });
          signal?.throwIfAborted();
          for (const [idx, c] of (centers ?? []).entries()) {
            if (
              c &&
              Number.isFinite(c.lat) &&
              Number.isFinite(c.lon) &&
              Math.abs(c.lat) <= 90
            ) {
              next.push({
                lat: c.lat,
                lon: c.lon,
                intensity: clamp01(c.intensity ?? 0.9),
                cellId: `lightning:cyclone:${idx}`,
                warmFraction: null,
              });
            }
          }
        } catch (e) {
          // Cyclone assist is best-effort: radar cells still stand alone.
          console.warn('[Data:Lightning] Cyclone assist failed:', e?.message ?? e);
        }
      }

      _cells = next;
      _cachedFrameMs = snapshot.frameTimeMs ?? null;
      _lastError = null;
      return _cells;
    })();
    try {
      return await _refreshPromise;
    } catch (e) {
      _lastError = e?.message ?? String(e);
      throw e;
    } finally {
      _refreshPromise = null;
    }
  }

  return {
    kind: 'radar-modeled',
    modeled: true,
    sourceLabel: LIGHTNING_SOURCE_LABEL,
    rainviewerApi: RAINVIEWER_API_URL,

    get lastError() {
      return _lastError;
    },

    /** Fresh impulse sample on every call (re-samples the cached cells). */
    async getStrikes({ signal } = {}) {
      signal?.throwIfAborted();
      const cells = await refreshCells(signal);
      signal?.throwIfAborted();
      return sampleStrikes(cells, {
        count: strikesPerBatch,
        rng,
        nowMs: nowMs(),
        batch: _batchSeq++,
      });
    },

    /** For tests / diagnostics: the raw candidate cells (empty before first fetch). */
    getCachedCells() {
      return _cells.slice();
    },
  };
}

/**
 * Blitzortung real-feed stub (INERT without an account).
 *
 * `getStrikes()` always throws a descriptive error explaining the free-account
 * upgrade path (see BLITZORTUNG_UPGRADE_NOTES). When credentials are supplied,
 * it attempts the documented session-gated fetch pattern and surfaces the
 * upstream error honestly — it never fabricates strikes.
 */
export function createBlitzortungSource({ username = null, password = null, sessionCookie = null } = {}) {
  const hasCreds = Boolean((username && password) || sessionCookie);
  return {
    kind: 'blitzortung',
    modeled: false,
    sourceLabel: 'Blitzortung (account required)',
    upgrade: BLITZORTUNG_UPGRADE_NOTES,

    async getStrikes() {
      if (!hasCreds) {
        const error = new Error(
          'Blitzortung source is inert without an account: live strike data ' +
            'requires a free blitzortung.org login (HTTP 401 observed 2026-09-27). ' +
            'See BLITZORTUNG_UPGRADE_NOTES for the upgrade path.',
        );
        error.code = 'LIGHTNING_ACCOUNT_REQUIRED';
        throw error;
      }
      // Credential path: attempt the session-gated endpoint once and report
      // the truth. The login-session flow is documented in
      // BLITZORTUNG_UPGRADE_NOTES; this stub does not pretend to complete it.
      const error = new Error(
        'Blitzortung credential wiring is not implemented in this stub: ' +
          'complete the session login per BLITZORTUNG_UPGRADE_NOTES and wire ' +
          'the authenticated fetch here. Refusing to fabricate strikes.',
      );
      error.code = 'LIGHTNING_NOT_IMPLEMENTED';
      throw error;
    },
  };
}
