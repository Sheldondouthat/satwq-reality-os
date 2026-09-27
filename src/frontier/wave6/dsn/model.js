/**
 * Wave 6 — NASA DSN dish status + active spacecraft.
 *
 * Ticker model (pure, no DOM) for GET /api/dsn.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickArr,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/dsn';
export const EMOJI = '🔭';
export const LABEL = 'Deep Space Network';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const dishes = pickArr(doc.dishes);
      const tracking = dishes.filter((d) => d.tracking).length;
      const sc = pickArr(doc.activeSpacecraft).length;
      if (!dishes.length && !sc) return null;
      return withTags(`${EMOJI} DSN ${tracking}/${dishes.length} dishes tracking · ${sc} spacecraft`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const names = pickArr(doc.activeSpacecraft).slice(0, 3).map((s) => pickStr(s.spacecraft, s.name)).filter(Boolean);
      return names.length ? `in contact: ${names.join(', ')}` : '';
    }
