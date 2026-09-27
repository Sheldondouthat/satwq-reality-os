/**
 * F2 — Planetary DVR: date-controllable GIBS snapshot source.
 *
 * Reuses the verified WMTS template builder from imageryTile/products.js
 * (read-only import — that module is untouched). The source owns a mutable
 * "current date"; the layer asks for a snapshot and gets the template for
 * that date. `probeDate` checks a single low-zoom tile before the layer
 * commits to a date, using GIBS's `layer-time-actual` header to detect
 * silent nearest-frame substitution on missing dates.
 */
import {
  GIBS_PRODUCTS,
  GIBS_CREDIT,
  gibsTileTemplate,
  yesterdayDateUTC,
} from '../imageryTile/products.js';
import {
  isValidGibsDate,
  gibsDateToMs,
  parseLayerTimeActual,
  isDateAvailable,
} from './model.js';

const PRODUCT = GIBS_PRODUCTS.truecolor;

/** Concrete tile URL used for availability probes (z=2 keeps it tiny). */
export function probeTileUrl(product, dateStr) {
  return gibsTileTemplate({
    layerName: product.wmtsLayer,
    matrixSet: product.matrixSet,
    ext: product.ext,
    date: dateStr,
  })
    .replace('{z}', '2')
    .replace('{y}', '2')
    .replace('{x}', '1');
}

export function createDvrSource({
  product = PRODUCT,
  now = () => Date.now(),
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  if (!product?.wmtsLayer)
    throw new TypeError('createDvrSource requires a GIBS product config');
  let _date = null; // null => follow latest (yesterday)

  return {
    /** Set the frame date (YYYY-MM-DD). Throws on invalid input. */
    setDate(dateStr) {
      if (!isValidGibsDate(dateStr))
        throw new TypeError(`DVR setDate: invalid date ${JSON.stringify(dateStr)}`);
      _date = dateStr;
    },

    /** Return to live/latest mode (yesterday's frame). */
    setLive() {
      _date = null;
    },

    getDate() {
      return _date || yesterdayDateUTC(now());
    },

    isLive() {
      return _date === null;
    },

    /**
     * Probe whether a date has real tiles. Returns
     * `{ available, actualDate, requestedDate }`.
     */
    async probeDate(dateStr, { signal } = {}) {
      if (!isValidGibsDate(dateStr))
        throw new TypeError(`DVR probeDate: invalid date ${JSON.stringify(dateStr)}`);
      signal?.throwIfAborted();
      const response = await fetchImpl(probeTileUrl(product, dateStr), {
        signal,
      });
      const actualDate = parseLayerTimeActual(
        response.headers?.get?.('layer-time-actual'),
      );
      const result = {
        available: isDateAvailable({
          ok: response.ok,
          actualDate,
          requestedDate: dateStr,
        }),
        actualDate,
        requestedDate: dateStr,
        status: response.status,
      };
      if (!result.available) {
        const err = new Error(
          `GIBS has no ${product.wmtsLayer} frame for ${dateStr}` +
            (actualDate ? ` (nearest is ${actualDate})` : ''),
        );
        err.code = 'DVR_DATE_UNAVAILABLE';
        err.detail = result;
        throw err;
      }
      return result;
    },

    async getSnapshot({ signal } = {}) {
      signal?.throwIfAborted();
      const date = _date || yesterdayDateUTC(now());
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
        timeMs: gibsDateToMs(date),
      };
    },
  };
}
