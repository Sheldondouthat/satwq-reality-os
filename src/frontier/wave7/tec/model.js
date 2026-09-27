/**
 * Wave 7 — GloTEC ionosphere snapshot (snapshot pipeline).
 *
 * Ticker model (pure, no DOM) for GET /api/tec.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/tec';
export const EMOJI = '🌐';
export const LABEL = 'Ionosphere TEC';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      if (!doc.snapshot) return `${EMOJI} TEC snapshot pending`;
      return withTags(`${EMOJI} ionosphere TEC`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      return doc.snapshot ? `snapshot ${pickStr(doc.snapshot.fetchedAt, 'n/a')}` : 'no snapshot yet — pipeline pending';
    }
