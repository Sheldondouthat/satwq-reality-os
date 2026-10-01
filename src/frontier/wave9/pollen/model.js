/**
 * Wave 9 — CAMS pollen forecasts — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/pollen.
 *
 * HONESTY: CAMS (Copernicus Atmosphere Monitoring Service) pollen is MODEL
 * output — a chemistry-transport simulation, not sensor observations. The
 * valueLine returns null when the payload carries no usable summary;
 * withTags() appends (stale) from the envelope. All values are grains/m³;
 * null = no model value (never zero-filled upstream).
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/pollen';
export const EMOJI = '🌾';
export const LABEL = 'Pollen (CAMS model)';

const TYPE_LABELS = {
  alder: 'alder',
  birch: 'birch',
  grass: 'grass',
  mugwort: 'mugwort',
  olive: 'olive',
  ragweed: 'ragweed',
};

/** Highest current reading across all locations, for the headline. */
function headline(locations) {
  let best = null;
  for (const loc of locations) {
    if (!loc || !loc.ok || !loc.current) continue;
    for (const [type, v] of Object.entries(loc.current)) {
      const n = pickNum(v);
      if (n == null) continue;
      if (!best || n > best.value) best = { value: n, type, city: loc.name };
    }
  }
  return best;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const locations = Array.isArray(doc.locations) ? doc.locations : [];
  const ok = locations.filter((l) => l && l.ok);
  if (!ok.length) return null;
  const best = headline(ok);
  const units = typeof doc.units === 'string' ? doc.units : 'grains/m³';
  const bestBit = best ? ` · ${TYPE_LABELS[best.type] ?? best.type} ${best.value} ${units} (${best.city})` : '';
  return withTags(`${EMOJI} Pollen ${ok.length} EU cities${bestBit} — CAMS model`, doc);
}

function fmtLoc(loc) {
  if (!loc || !loc.ok || !loc.current) return null;
  const bits = Object.entries(loc.current)
    .map(([t, v]) => (pickNum(v) != null ? `${t} ${pickNum(v)}` : null))
    .filter(Boolean);
  const cov = loc.coverage === 'outside-cams-pollen-domain' ? ' (no CAMS coverage)' : '';
  return `${loc.name}: ${bits.join(', ') || 'no data'}${cov}`;
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const locations = Array.isArray(doc.locations) ? doc.locations : [];
  const rows = locations.map(fmtLoc).filter(Boolean);
  const parts = [];
  if (rows.length) parts.push(rows.join(' · ') + ' grains/m³.');
  parts.push('CAMS model output — simulation, not sensor observations; null = no model value.');
  return parts.join(' ');
}
