/**
 * Wave 8 — NDBC/IOOS HF-radar surface currents (snapshot pipeline).
 *
 * Ticker model (pure, no DOM) for GET /api/currents.
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

export const ROUTE = '/api/currents';
export const EMOJI = '🌊';
export const LABEL = 'HF-radar currents';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      if (!doc.snapshot) return `${EMOJI} HF-radar currents snapshot pending`;
      const r = pickArr(doc.regions);
      return withTags(`${EMOJI} HF-radar currents · ${r.length} regions`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      if (!doc.snapshot) return 'no snapshot yet — pipeline pending';
      const names = pickArr(doc.regions).slice(0, 3).map((x) => pickStr(x.name, x.id)).filter(Boolean);
      return `snapshot ${pickStr(doc.snapshot.fetchedAt, 'n/a')}${names.length ? ` · ${names.join(', ')}` : ''}`;
    }
