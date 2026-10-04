/**
 * Wave 9 — Great Lakes water levels — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/great-lakes.
 *
 * HONESTY: lake-wide coordinated MONTHLY MEANS (the Coordinating Committee
 * gauge-network average, meters above IGLD 1985) — not real-time, not a
 * single gauge, not a forecast. The upstream record updates ~annually, so
 * the latest month trails real time (see payload honesty.updateLag).
 * Anomaly = latest month minus the full-record mean; descriptive only.
 * Lakes Michigan and Huron are one hydrologic unit upstream (single series).
 * The valueLine returns null when the payload carries no usable summary;
 * withTags() appends (stale) from the envelope.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/great-lakes';
export const EMOJI = '🌊';
export const LABEL = 'Great Lakes levels';

function fmtFt(v) {
  const n = pickNum(v);
  if (n == null) return null;
  return `${n.toLocaleString('en-US', { maximumFractionDigits: 2 })} ft`;
}

function headline(doc) {
  const lakes = (Array.isArray(doc.lakes) ? doc.lakes : []).filter(
    (l) => l && l.ok && l.latest,
  );
  return { lakes };
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const { lakes } = headline(doc);
  if (!lakes.length) return null;
  const all = Array.isArray(doc.lakes) ? doc.lakes.length : lakes.length;
  const dark = all - lakes.length;
  const supers = lakes.find((l) => l.id === 'superior');
  const bit = supers
    ? ` · Superior ${fmtFt(supers.latest.levelFt)} (${supers.latest.month})`
    : '';
  const darkBit = dark ? ` · ${dark} dark` : '';
  return withTags(
    `${EMOJI} Great Lakes ${lakes.length}/${all} lakes${bit}${darkBit} · monthly means`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const { lakes } = headline(doc);
  return lakes
    .map((l) => {
      const a = pickNum(l.anomaly?.levelFt);
      const aBit =
        a == null ? '' : ` (${a >= 0 ? '+' : ''}${a.toFixed(2)} ft vs mean)`;
      return `${l.name}: ${fmtFt(l.latest.levelFt)} @ ${l.latest.month}${aBit}`;
    })
    .join('\n');
}
