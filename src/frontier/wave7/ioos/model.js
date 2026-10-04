/**
 * Wave 7 — IOOS glider missions + sensor datasets.
 *
 * Ticker model (pure, no DOM) for GET /api/ioos.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
  sourceHealthLine,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/ioos';
export const EMOJI = '⚓';
export const LABEL = 'IOOS ocean data';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const m = pickNum(doc.gliders?.activeMissions, doc.gliders?.missions?.length);
  const d = pickNum(doc.sensors?.activeDatasets);
  const c = pickNum(doc.coastwatch?.activeProducts);
  if (m == null && d == null && c == null) return null;
  return withTags(
    `${EMOJI} IOOS ${m ?? '?'} glider missions · ${d ?? '?'} sensor datasets · ${c ?? '?'} CoastWatch products`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  return sourceHealthLine(doc);
}
