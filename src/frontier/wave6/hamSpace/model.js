/**
 * Wave 6 — amateur-radio space-weather sources (ARISS, e-Callisto).
 *
 * Ticker model (pure, no DOM) for GET /api/ham-space.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickStr,
  sourceHealthLine,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/ham-space';
export const EMOJI = '🛰️';
export const LABEL = 'Ham radio space weather';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const health = sourceHealthLine(doc);
      if (!health) return null;
      return withTags(`${EMOJI} ham radio space wx · ${health}`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const ariss = pickStr(doc.ariss?.status, doc.ariss?.nextPass);
      return ariss ? `ARISS: ${ariss}` : sourceHealthLine(doc);
    }
