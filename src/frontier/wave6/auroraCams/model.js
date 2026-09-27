/**
 * Wave 6 — all-sky aurora camera manifest (images load client-side).
 *
 * Ticker model (pure, no DOM) for GET /api/aurora-cams.
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

export const ROUTE = '/api/aurora-cams';
export const EMOJI = '🌌';
export const LABEL = 'Aurora cameras';

export function valueLine(doc) {
      if (isUnavailable(doc)) return null;
      const n = pickNum(doc.count, doc.cams?.length);
      if (n == null) return null;
      return withTags(`${EMOJI} ${n} aurora cams`, doc);
    }

export function detailLine(doc) {
      if (isUnavailable(doc)) return '';
      const names = pickArr(doc.cams).slice(0, 3).map((c) => pickStr(c.name)).filter(Boolean);
      return names.length ? names.join(' · ') : '';
    }
export function thumbUrls(doc) {
      return pickArr(doc.cams).slice(0, 4).map((c) => ({
        url: pickStr(c.url),
        caption: `${pickStr(c.name)}${c.probe === 'vm-000' ? ' · needs edge probe' : ''}`.trim(),
      })).filter((t) => t.url);
    }
