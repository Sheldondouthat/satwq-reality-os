/**
 * Wave 8 — NHC tropical-cyclone GIS product index.
 *
 * Ticker model (pure, no DOM) for GET /api/nhc-gis.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
  pickArr,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/nhc-gis';
export const EMOJI = '🌀';
export const LABEL = 'NHC GIS products';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const n = pickNum(doc.productCount, doc.products?.length);
      if (n == null) return null;
      return withTags(`${EMOJI} ${n} NHC GIS products`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const ids = pickArr(doc.products).slice(0, 3).map((p) => pickStr(p.stormId, p.filename)).filter(Boolean);
      return ids.length ? ids.join(' · ') : '';
    }
