/**
 * Wave 6 — volcano webcam manifest (AVO + others).
 *
 * Ticker model (pure, no DOM) for GET /api/volcano-cams.
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
  sourceHealthLine,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/volcano-cams';
export const EMOJI = '🌋';
export const LABEL = 'Volcano cameras';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const n = pickNum(doc.count, doc.cams?.length);
  if (n == null) return null;
  return withTags(`${EMOJI} ${n} volcano cams`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const health = sourceHealthLine(doc);
  const names = pickArr(doc.cams)
    .slice(0, 2)
    .map((c) => pickStr(c.name))
    .filter(Boolean);
  return [names.join(' · '), health].filter(Boolean).join(' · ');
}
export function thumbUrls(doc) {
  return pickArr(doc.cams)
    .slice(0, 4)
    .map((c) => ({
      url: pickStr(c.url),
      caption: pickStr(c.name),
    }))
    .filter((t) => t.url);
}
