/**
 * Wave 8 — USGS geomagnetic observatory (default BOU).
 *
 * Ticker model (pure, no DOM) for GET /api/geomag-usgs.
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

export const ROUTE = '/api/geomag-usgs';
export const EMOJI = '🧭';
export const LABEL = 'Geomag (USGS)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const lv = doc.latestValid ?? doc.latest;
  if (!lv) return null;
  const h = pickNum(lv.h);
  const d = pickNum(lv.d);
  const mag = h != null ? `H ${h} nT` : `X ${pickNum(lv.x) ?? '?'} nT`;
  return withTags(
    `${EMOJI} ${pickStr(doc.observatory?.code, 'BOU')} ${mag}${d != null ? ` D ${d}°` : ''}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const lv = doc.latestValid ?? doc.latest ?? {};
  return `latest valid ${pickStr(lv.t, 'n/a')}`;
}
