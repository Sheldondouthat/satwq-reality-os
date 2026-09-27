/**
 * Wave 6 — live glider positions (OGN).
 *
 * Ticker model (pure, no DOM) for GET /api/gliders.
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

export const ROUTE = '/api/gliders';
export const EMOJI = '🪂';
export const LABEL = 'Gliders (live)';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const n = pickNum(doc.count, doc.markers?.length);
      if (n == null) return null;
      return withTags(`${EMOJI} ${n.toLocaleString('en-US')} gliders live`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const m = pickArr(doc.markers)[0];
      if (!m) return '';
      const alt = pickNum(m.altM);
      const spd = pickNum(m.speedKmh);
      return `${pickStr(m.reg, m.cn, 'glider')}${alt != null ? ` · ${alt.toLocaleString('en-US')} m` : ''}${spd != null ? ` · ${spd} km/h` : ''}`;
    }
