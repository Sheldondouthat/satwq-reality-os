/**
 * Wave 6 — latest solar image manifest (SDO/SOHO/PROBA-2).
 *
 * Ticker model (pure, no DOM) for GET /api/solar-img.
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

export const ROUTE = '/api/solar-img';
export const EMOJI = '☀️';
export const LABEL = 'Solar imagery';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.images?.length);
  if (n == null) return null;
  return withTags(`${EMOJI} ${n} solar images`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  return pickStr(doc.attribution);
}
export function thumbUrls(doc) {
  return pickArr(doc.images)
    .slice(0, 4)
    .map((i) => ({
      url: pickStr(i.url),
      caption: pickStr(i.name, i.title),
    }))
    .filter((t) => t.url);
}
