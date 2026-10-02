/**
 * Wave 9 — surf & sea state — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/surf.
 *
 * HONESTY: the provider serves NWS gridded wave FORECASTS (WaveWatch-III
 * derived model output), not observations. valueLine names the max spot and
 * always says "forecast". A valueLine of null means the payload carries no
 * usable summary — the ticker stays silent rather than guessing. Feet are
 * derived from the provider's native meters (m × 3.28084).
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/surf';
export const EMOJI = '🏄';
export const LABEL = 'Surf & sea state';
export const M_TO_FT = 3.28084;

export function toFt(m) {
  const v = pickNum(m);
  return v == null ? null : v * M_TO_FT;
}

function spotLine(s) {
  const ft = toFt(s?.latest?.waveHeightM);
  if (ft == null) return `${s?.name ?? s?.id ?? '?'}: no forecast`;
  const per = pickNum(s?.latest?.wavePeriodS);
  return `${s.name}: ${ft.toFixed(1)} ft${per != null ? ` / ${per.toFixed(0)} s` : ''}`;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const summary = doc.summary;
  const maxM = pickNum(summary?.maxWaveHeightM);
  const ok = pickNum(summary?.ok);
  if (maxM == null || ok == null) return null;
  const spots = Array.isArray(doc.spots) ? doc.spots : [];
  const maxSpot = spots.find((s) => s?.id === summary.maxWaveSpotId);
  const where = maxSpot ? ` @ ${maxSpot.name}` : '';
  return withTags(
    `${EMOJI} Surf forecast: ${(maxM * M_TO_FT).toFixed(1)} ft max next 24h${where} · ${ok}/${pickNum(summary?.total) ?? '?'} spots`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const spots = Array.isArray(doc.spots) ? doc.spots : [];
  const live = spots.filter((s) => s?.ok);
  if (!live.length) return 'No surf forecast data at last update.';
  const rows = live.slice(0, 5).map(spotLine);
  const parts = [rows.join(' · ')];
  if (live.length > 5) parts.push(`+${live.length - 5} more spots`);
  parts.push('Model forecast (WaveWatch-III-derived), not buoy observations.');
  return parts.join(' ');
}
