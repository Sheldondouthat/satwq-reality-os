/**
 * Wave 6 — coral bleaching alert animations (NOAA CRW).
 *
 * Ticker model (pure, no DOM) for GET /api/coral.
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

export const ROUTE = '/api/coral';
export const EMOJI = '🪸';
export const LABEL = 'Coral bleaching';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const n = pickNum(doc.count, doc.animations?.length);
      if (n == null) return null;
      return withTags(`${EMOJI} ${n} coral-bleaching animations`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      return pickStr(doc.attribution);
    }
export function thumbUrls(doc) {
      return pickArr(doc.animations).slice(0, 4).map((a) => ({
        url: pickStr(a.url),
        caption: pickStr(a.name, a.region),
      })).filter((t) => t.url);
    }
