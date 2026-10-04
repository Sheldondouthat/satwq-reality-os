/**
 * Wave 8 — ISS position + crew (open-notify, staleness-guarded).
 *
 * Ticker model (pure, no DOM) for GET /api/iss-ext.
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

export const ROUTE = '/api/iss-ext';
export const EMOJI = '🚀';
export const LABEL = 'ISS + crew';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const iss = doc.iss ?? {};
  const lat = pickNum(iss.latitude);
  const lon = pickNum(iss.longitude);
  if (lat == null || lon == null) return null;
  const crew = pickNum(doc.astros?.number);
  return withTags(
    `${EMOJI} ISS ${lat.toFixed(1)}°, ${lon.toFixed(1)}°${crew != null ? ` · ${crew} aboard` : ''}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const iss = doc.iss ?? {};
  const ageMs = pickNum(iss.dataAgeMs);
  return `position age ${ageMs != null ? `${Math.round(ageMs / 1000)}s` : 'n/a'}${pickStr(iss.staleReason) ? ` · ${iss.staleReason}` : ''}`;
}
