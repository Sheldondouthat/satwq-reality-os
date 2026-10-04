/**
 * Wave 9 — USACE reservoir levels — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/usace.
 *
 * HONESTY: daily storage (ac-ft) + hourly pool elevation (ft) are the latest
 * OBSERVED series values from the USACE CWMS Data API (Missouri mainstem,
 * Omaha District) — no forecasts, no model, no interpolation. Each row
 * carries its own timestamp and age; ages are the authority (the CDA
 * catalog can lag the series itself). No %full is ever shown — upstream
 * location records carry no capacity fields.
 * The valueLine returns null when the payload carries no usable summary;
 * withTags() appends (stale) from the envelope.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/usace';
export const EMOJI = '🌊';
export const LABEL = 'USACE reservoirs';

function fmtAcFt(v) {
  const n = pickNum(v);
  if (n == null) return null;
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toLocaleString('en-US', { maximumFractionDigits: 1 })}M ac-ft`;
  if (n >= 1_000)
    return `${(n / 1_000).toLocaleString('en-US', { maximumFractionDigits: 0 })}k ac-ft`;
  return `${n.toLocaleString('en-US')} ac-ft`;
}

function headline(doc) {
  const rows = (Array.isArray(doc.reservoirs) ? doc.reservoirs : []).filter(
    (r) => r && r.ok,
  );
  let best = null;
  for (const r of rows) {
    const s = pickNum(r.storage?.acFt);
    if (s == null) continue;
    if (!best || s > best.s) best = { r, s };
  }
  return { rows, best };
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const { rows, best } = headline(doc);
  if (!rows.length) return null;
  const dark =
    (Array.isArray(doc.reservoirs) ? doc.reservoirs.length : rows.length) -
    rows.length;
  const total = rows.reduce((a, r) => a + (pickNum(r.storage?.acFt) ?? 0), 0);
  const totalBit = fmtAcFt(total);
  const bestBit = best ? ` · ${best.r.code} ${fmtAcFt(best.s)}` : '';
  const darkBit = dark ? ` · ${dark} dark` : '';
  return withTags(
    `${EMOJI} USACE ${rows.length} Missouri reservoirs${totalBit ? ` — ${totalBit} total${bestBit}` : ''}${darkBit} · observed`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const rows = (Array.isArray(doc.reservoirs) ? doc.reservoirs : []).filter(
    (r) => r && r.ok,
  );
  const parts = rows.map((r) => {
    const stor = fmtAcFt(pickNum(r.storage?.acFt));
    const storAge = pickNum(r.storage?.ageDays);
    const elev = pickNum(r.poolElevation?.ft);
    const elevAge = pickNum(r.poolElevation?.ageDays);
    const bits = [];
    if (stor)
      bits.push(`${stor}${storAge != null ? ` (${storAge}d ago)` : ''}`);
    if (elev != null)
      bits.push(
        `pool ${elev.toLocaleString('en-US', { maximumFractionDigits: 1 })} ft${elevAge != null ? ` (${elevAge}d ago)` : ''}`,
      );
    return `${r.code}: ${bits.join(' · ') || 'no data'}.`;
  });
  parts.push(
    'Latest observed storage (daily) + pool elevation (hourly) from the USACE CWMS Data API, Missouri River mainstem; no %full shown (upstream carries no capacity fields).',
  );
  return parts.join(' ');
}
