/**
 * Wave 9 — Lunar ephemeris — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/moon (R2-21).
 *
 * HONESTY: everything on this route is COMPUTED GEOMETRY from the repo
 * low-precision lunar ephemeris (simplified Meeus/Schlyter) — phase ±~0.5d,
 * rise/set ±~5–15 min at mid-latitudes. Never an observation. "perigean" is
 * the computed <370,000 km flag, not a supermoon claim.
 * valueLine returns null when the payload carries no usable phase; the
 * detail line names rise/set (when an observer was requested) and the next
 * canonical event.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/moon';
export const EMOJI = '🌙';
export const LABEL = 'Lunar ephemeris';

function phaseOf(doc) {
  return doc && doc.phase && typeof doc.phase.name === 'string' ? doc.phase : null;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const p = phaseOf(doc);
  if (!p) return null;
  const illum = Number.isFinite(p.illumination) ? ` ${(p.illumination * 100).toFixed(1)}%` : '';
  const next = Array.isArray(doc.upcoming) && doc.upcoming.length > 0 ? doc.upcoming[0] : null;
  const nextBit = next ? ` · ${next.type} in ${next.daysAway}d` : '';
  return withTags(`${EMOJI} ${p.name}${illum}${nextBit}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const p = phaseOf(doc);
  const parts = [];
  if (p) {
    parts.push(
      `${p.name}, ${(p.illumination * 100).toFixed(1)}% illuminated, elongation ${p.elongationDeg}° (${p.waxing ? 'waxing' : 'waning'}).`,
    );
  }
  if (Number.isFinite(doc?.distanceKm)) {
    parts.push(
      `${doc.distanceKm.toLocaleString('en-US')} km away${doc.perigean ? ' (computed perigean)' : ''}.`,
    );
  }
  const rs = doc?.riseSet;
  if (rs && (rs.moonrise || rs.moonset)) {
    const clock = (t) => String(t ?? '').slice(11, 16);
    const bits = [];
    if (rs.moonrise) bits.push(`moonrise ${clock(rs.moonrise)}`);
    if (rs.moonset) bits.push(`moonset ${clock(rs.moonset)}`);
    parts.push(`${bits.join(' / ')} UTC (computed, ±~5–15 min).`);
  } else if (doc?.observer) {
    parts.push('No rise/set this UTC day (computed).');
  }
  const next = Array.isArray(doc?.upcoming) ? doc.upcoming[1] : null;
  if (next) parts.push(`Then ${next.type} ${String(next.date).slice(0, 10)} (${next.daysAway}d).`);
  parts.push('Computed geometry from the repo lunar ephemeris — not an observation.');
  return parts.join(' ');
}

export function eventCount(doc) {
  return Array.isArray(doc?.upcoming) ? doc.upcoming.length : pickNum(doc?.upcoming);
}
