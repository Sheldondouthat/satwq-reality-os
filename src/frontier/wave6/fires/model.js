/**
 * Wave 6 — fire incidents + detections (NIFC + HMS).
 *
 * Ticker model (pure, no DOM) for GET /api/fires.
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
  itemName,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/fires';
export const EMOJI = '🔥';
export const LABEL = 'Fire incidents';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const inc = pickNum(doc.counts?.incidents);
  const det = pickNum(doc.counts?.detections);
  if (inc == null && det == null) {
    const n = pickNum(doc.count, doc.fires?.length);
    if (n == null) return null;
    return withTags(`${EMOJI} ${n.toLocaleString('en-US')} fire reports`, doc);
  }
  return withTags(
    `${EMOJI} ${inc ?? 0} incidents · ${det ?? 0} detections`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const f = pickArr(doc.fires)[0];
  return f ? `${itemName(f)}${pickStr(f.kind) ? ` (${f.kind})` : ''}` : '';
}
