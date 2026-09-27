/**
 * Wave 8 — gravitational-wave candidates — MDC mocks labeled.
 *
 * Ticker model (pure, no DOM) for GET /api/gracedb.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/gracedb';
export const EMOJI = '💫';
export const LABEL = 'GraceDB (MDC)';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const real = pickNum(doc.realCount);
      const mock = pickNum(doc.mockCount);
      if (real == null && mock == null) {
        const n = pickNum(doc.total, doc.returned, doc.events?.length);
        if (n == null) return null;
        return withTags(`${EMOJI} ${n} GraceDB events (MDC: mocks possible)`, doc);
      }
      return withTags(`${EMOJI} GraceDB ${real ?? 0} real · ${mock ?? 0} mock (MDC)`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      return pickStr(doc.disclaimer).slice(0, 160);
    }
