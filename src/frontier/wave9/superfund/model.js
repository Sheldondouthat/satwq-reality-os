/**
 * Wave 9 — EPA Superfund NPL sites — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/superfund.
 *
 * HONESTY: the NPL is EPA's list of the country's most serious uncontrolled
 * hazardous-waste sites. "Final" = formally listed, "proposed" = proposed
 * for listing; listing is not a cleanup-status readout. valueLine names the
 * top state; detailLine carries the final/proposed split and the top-5
 * states. Coordinates in the payload are EPA facility centroids.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/superfund';
export const EMOJI = '☣️';
export const LABEL = 'Superfund NPL sites';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const total = pickNum(doc.summary?.total);
  if (total == null) return null;
  const top = Array.isArray(doc.summary?.topStates)
    ? doc.summary.topStates[0]
    : null;
  const topBit = top ? ` — most in ${top.state} (${top.count})` : '';
  return withTags(
    `${EMOJI} Superfund NPL: ${total} site${total === 1 ? '' : 's'}${topBit}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const by = doc.summary?.byStatus ?? {};
  const tops = (doc.summary?.topStates ?? []).slice(0, 5);
  const parts = [
    `Final NPL ${by.final ?? '?'} · proposed ${by.proposed ?? '?'}.`,
  ];
  if (tops.length) {
    parts.push(
      `Top states: ${tops.map((t) => `${t.state} ${t.count}`).join(', ')}.`,
    );
  }
  parts.push(
    'Listing is not a cleanup-status readout; coordinates are EPA facility centroids.',
  );
  return parts.join(' ');
}
