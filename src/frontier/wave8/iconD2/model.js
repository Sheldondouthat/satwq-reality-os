/**
 * Wave 8 — ICON-D2 forecast snapshot (snapshot pipeline).
 *
 * Ticker model (pure, no DOM) for GET /api/icon-d2.
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

export const ROUTE = '/api/icon-d2';
export const EMOJI = '🌦️';
export const LABEL = 'ICON-D2 forecast';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      if (!doc.snapshot) return `${EMOJI} ICON-D2 snapshot pending`;
      const h = pickArr(doc.horizons).length;
      return withTags(`${EMOJI} ICON-D2${h ? ` · ${h} horizons` : ''}`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      return doc.snapshot ? `snapshot ${pickStr(doc.snapshot.fetchedAt, 'n/a')}` : 'no snapshot yet — pipeline pending';
    }
