/**
 * Wave 9 — OCEARCH shark tracker — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/ocearch.
 *
 * HONESTY: the provider reports SPOT-tag surfacing pings, not continuous
 * GPS trails. valueLine returns null when the payload carries no usable
 * animal counts; withTags() appends (stale)/(partial) from the envelope.
 * The detail line names the freshest ping so the ticker never implies
 * "live right now" for a tag that last surfaced weeks ago. Z-pings carry
 * no location — the provider labels them, never counts them.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/ocearch';
export const EMOJI = '🦈';
export const LABEL = 'OCEARCH shark tracks';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const ok = pickNum(doc.summary?.ok);
  const total = pickNum(doc.summary?.animals);
  const fresh = pickNum(doc.summary?.fresh);
  if (ok == null || total == null) return null;
  const freshBit = fresh != null && fresh > 0 ? ` · ${fresh} fresh` : '';
  return withTags(`${EMOJI} OCEARCH ${ok}/${total} sharks tracked${freshBit}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const animals = Array.isArray(doc.animals) ? doc.animals : [];
  const live = animals
    .filter((a) => a && a.ok && a.name && a.lastPing)
    .slice(0, 3)
    .map((a) => {
      const when = String(a.lastPing).slice(0, 10);
      const age = a.lastPingAgeDays != null ? ` ${a.lastPingAgeDays}d ago` : '';
      return `${a.name} (${when}${age})`;
    });
  const parts = [];
  if (live.length) parts.push(`Latest pings: ${live.join(' · ')}`);
  parts.push('SPOT tags ping only when the fin breaks the surface; z-pings have no location; straight lines between pings are not the true path.');
  return parts.join(' ');
}
