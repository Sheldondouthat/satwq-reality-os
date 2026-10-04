/**
 * Wave 9 — NASA Exoplanet Archive catalog — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/exoplanets.
 *
 * HONESTY: confirmed planets only (TOI/KOI candidates excluded upstream);
 * confirmedPlanets = COUNT(DISTINCT pl_name) over the ps table; disc_year is
 * the archive's discovery/announcement year. valueLine returns null when the
 * payload carries no usable summary; withTags() appends (stale)/(partial)
 * from the envelope.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/exoplanets';
export const EMOJI = '🪐';
export const LABEL = 'Exoplanet archive';

function fmtInt(n) {
  if (n == null) return null;
  return Math.round(n).toLocaleString('en-US');
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const count = pickNum(doc.confirmedPlanets);
  if (count == null) return null;
  const newest =
    Array.isArray(doc.latest) && doc.latest.length ? doc.latest[0] : null;
  const newestBit =
    newest && newest.name
      ? ` · newest ${newest.name}${newest.discYear != null ? ` (${newest.discYear})` : ''}`
      : '';
  return withTags(
    `${EMOJI} Exoplanets ${fmtInt(count)} confirmed${newestBit}`,
    doc,
  );
}

function fmtPlanet(p) {
  if (!p || !p.name) return null;
  const bits = [p.name];
  if (p.orbPeriodDays != null) bits.push(`${p.orbPeriodDays}d`);
  if (p.radiusEarth != null) bits.push(`${p.radiusEarth} R⊕`);
  if (p.massEarth != null) bits.push(`${p.massEarth} M⊕`);
  if (p.distPc != null) bits.push(`${p.distPc} pc`);
  return bits.join(' ');
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const latest = Array.isArray(doc.latest) ? doc.latest : [];
  const parts = [];
  if (doc.confirmedPlanets != null)
    parts.push(
      `${fmtInt(doc.confirmedPlanets)} confirmed exoplanets in the NASA Exoplanet Archive (candidates excluded).`,
    );
  const rows = latest.slice(0, 5).map(fmtPlanet).filter(Boolean);
  if (rows.length) parts.push(`Newest: ${rows.join(' · ')}.`);
  parts.push(
    'Discovery year = archive announcement year; blank parameters were never measured.',
  );
  return parts.join(' ');
}
