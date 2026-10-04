/**
 * Wave 9 — U.S. Drought Monitor weekly summary — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/usdm.
 *
 * HONESTY: category rows are cumulative ("at least D1") — the D1 row is the
 * share of the US in D1-or-worse drought, not a D1-only band. valueLine
 * returns null when the payload carries no usable summary; withTags()
 * appends (stale)/(partial) from the envelope. Week-over-week bits are the
 * provider's own percentage-point deltas, labeled as such in detailLine.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/usdm';
export const EMOJI = '🌵';
export const LABEL = 'US Drought Monitor';

function fmtPop(n) {
  if (n == null) return null;
  return n >= 1e6 ? `${Math.round(n / 1e6)}M` : `${Math.round(n / 1e3)}K`;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const d1 = pickNum(doc.summary?.d1PlusAreaPercent);
  const d3 = pickNum(doc.summary?.d3PlusAreaPercent);
  const pop = pickNum(doc.summary?.populationInDrought);
  if (d1 == null) return null;
  const popBit = fmtPop(pop) != null ? ` · ${fmtPop(pop)} people` : '';
  const d3Bit = d3 != null ? ` · D3+ ${d3}%` : '';
  return withTags(
    `${EMOJI} USDM ${d1}% of US in drought (D1+)${d3Bit}${popBit}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const cats = Array.isArray(doc.categories) ? doc.categories : [];
  const parts = [];
  if (doc.mapDate)
    parts.push(`Map week of ${doc.mapDate} (weekly; maps dated Tuesdays).`);
  const catBits = cats
    .filter((c) => c && c.areaPercent != null)
    .map((c) => {
      const wow =
        c.wowDeltaPctPoints != null
          ? ` (${c.wowDeltaPctPoints > 0 ? '+' : ''}${c.wowDeltaPctPoints} pts WoW)`
          : '';
      return `${c.level} ${c.areaPercent}%${wow}`;
    });
  if (catBits.length)
    parts.push(`Cumulative coverage: ${catBits.join(' · ')}.`);
  parts.push(
    'Rows are cumulative (D1 = D1-or-worse); D0/None not reported by this UNL feed.',
  );
  return parts.join(' ');
}
