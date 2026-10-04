/**
 * Wave 6 — self-contained fact cards (Wikimedia/WB/OpenLibrary/ClinicalTrials).
 *
 * Ticker model (pure, no DOM) for GET /api/knowledge.
 *
 * HONESTY: valueLine returns null when the payload carries no usable number
 * (the ticker then shows "unavailable — will retry"); withTags() appends
 * (stale)/(partial)/(model: simulation, not sensors) from the envelope.
 */
import {
  isUnavailable,
  withTags,
  pickArr,
  pickStr,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/knowledge';
export const EMOJI = '🧠';
export const LABEL = 'Knowledge cards';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const items = pickArr(doc.items);
  if (!items.length) return null;
  return withTags(`${EMOJI} ${items.length} knowledge cards`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  return pickArr(doc.items)
    .slice(0, 3)
    .map((i) => pickStr(i.headline))
    .filter(Boolean)
    .join(' · ');
}
