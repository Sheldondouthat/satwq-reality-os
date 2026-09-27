/**
 * Wave 6 — FEMA disaster declarations.
 *
 * Ticker model (pure, no DOM) for GET /api/disasters.
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

export const ROUTE = '/api/disasters';
export const EMOJI = '🏚️';
export const LABEL = 'Disaster declarations';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const n = pickNum(doc.count, doc.declarations?.length);
      if (n == null) return null;
      return withTags(`${EMOJI} ${n} disaster declarations`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const d = pickArr(doc.declarations)[0];
      if (!d) return '';
      return `latest: ${pickStr(d.state, d.designatedArea, d.title, 'declaration')}`;
    }
