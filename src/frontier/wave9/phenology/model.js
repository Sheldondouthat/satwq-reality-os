/**
 * Wave 9 — USA-NPN spring leaf/bloom anomaly — ticker model (pure, no DOM).
 *
 * HONESTY: model product (Extended Spring Indices), not observations.
 * Negative days = early vs the 30-year average; positive = late.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/phenology';
export const EMOJI = '🌱';
export const LABEL = 'Spring phenology';

function fmtDays(v) {
  const n = pickNum(v);
  if (n == null) return null;
  if (n === 0) return 'on time';
  return n < 0 ? `${-n}d early` : `${n}d late`;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const points = doc.points || [];
  const parts = [];
  for (const p of points) {
    if (!p?.ok) continue;
    const leaf = fmtDays(p.leafAnomalyDays);
    const bloom = fmtDays(p.bloomAnomalyDays);
    const bits = [leaf && `leaf ${leaf}`, bloom && `bloom ${bloom}`].filter(Boolean);
    if (bits.length) parts.push(`${p.id}: ${bits.join(', ')}`);
  }
  if (!parts.length) return null;
  const shown = parts.slice(0, 3).join(' · ');
  const more = parts.length > 3 ? ` (+${parts.length - 3} more)` : '';
  return withTags(`${EMOJI} spring: ${shown}${more}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const parts = [];
  for (const p of doc.points || []) {
    if (!p?.ok) continue;
    parts.push(`${p.label}: leaf ${fmtDays(p.leafAnomalyDays) ?? 'no data'}, bloom ${fmtDays(p.bloomAnomalyDays) ?? 'no data'}.`);
  }
  if (!parts.length) parts.push('No phenology data in this payload.');
  parts.push('USA-NPN Extended Spring Index model vs 30-year average — days early(-)/late(+), not direct observations.');
  return parts.join(' ');
}
