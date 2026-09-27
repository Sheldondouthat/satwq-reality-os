/**
 * Wave 6 — real lightning strikes (Blitzortung) — complements the modeled F4 layer.
 *
 * Ticker model (pure, no DOM) for GET /api/lightning.
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
  ageAgo,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/lightning';
export const EMOJI = '⚡';
export const LABEL = 'Lightning (Blitzortung)';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const n = pickNum(doc.count, doc.strikes?.length);
      if (n == null) return null;
      return withTags(`${EMOJI} ${n.toLocaleString('en-US')} strikes`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const strikes = pickArr(doc.strikes);
      const last = strikes[strikes.length - 1];
      return last?.time ? `newest strike ${ageAgo(last.time)}` : '';
    }
