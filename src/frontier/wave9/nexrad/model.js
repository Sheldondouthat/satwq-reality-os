/**
 * Wave 9 — NEXRAD radar-site liveness — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/nexrad.
 *
 * HONESTY: lastScan is the last time NWS received a Level-II volume scan
 * from the radar (site liveness), NOT a rendered product and NOT a
 * precipitation measurement. valueLine returns null when the payload
 * carries no usable station counts; withTags() appends
 * (stale)/(partial) from the envelope.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/nexrad';
export const EMOJI = '📡';
export const LABEL = 'NEXRAD radar liveness';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const fresh = pickNum(doc.summary?.fresh);
  const total = pickNum(doc.summary?.total, doc.count);
  const dark = pickNum(doc.summary?.dark);
  if (fresh == null || total == null) return null;
  const darkBit = dark != null && dark > 0 ? ` · ${dark} dark` : '';
  return withTags(
    `${EMOJI} NEXRAD ${fresh}/${total} radars fresh (Lvl-II ≤15m)${darkBit}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const byType = doc.summary?.byType ?? {};
  const parts = Object.entries(byType).map(([t, n]) => `${n} ${t}`);
  return parts.length
    ? `Site liveness — ${parts.join(' · ')}. lastScan = last Level-II receipt by NWS, not imagery.`
    : '';
}
