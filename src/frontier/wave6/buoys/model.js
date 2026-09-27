/**
 * Wave 6 — NDBC buoy observations.
 *
 * Ticker model (pure, no DOM) for GET /api/buoys.
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

export const ROUTE = '/api/buoys';
export const EMOJI = '🛟';
export const LABEL = 'Ocean buoys';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const n = pickNum(doc.count, doc.buoys?.length);
      if (n == null) return null;
      return withTags(`${EMOJI} ${n.toLocaleString('en-US')} buoys reporting`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const ids = pickArr(doc.buoys).slice(0, 3).map((b) => pickStr(b.id, b.station)).filter(Boolean);
      return ids.length ? `stations: ${ids.join(', ')}` : '';
    }
