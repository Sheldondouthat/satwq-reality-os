/**
 * Wave 9 — FAA airport delays (NAS status) — ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/faa-delays.
 *
 * HONESTY: the FAA document lists ONLY active delay programs, ground stops
 * and closures — absence of a section means zero active of that kind, not
 * missing data. Durations are the FAA's as-published strings (carried
 * verbatim by the provider); valueLine uses them as-is, never normalized.
 * valueLine returns null when the payload carries no usable summary; the
 * detail line names the affected airports so the ticker never implies a
 * national ground stop when only BOS has a program.
 */
import {
  isUnavailable,
  withTags,
  pickNum,
} from '../../wave3/common/ticker.js';

export const ROUTE = '/api/faa-delays';
export const EMOJI = '🛫';
export const LABEL = 'FAA airport delays';

function sectionCount(doc, needle) {
  const byType = doc?.summary?.byType;
  if (!byType || typeof byType !== 'object') return null;
  let n = 0;
  let found = false;
  for (const [name, count] of Object.entries(byType)) {
    if (name.toLowerCase().includes(needle)) {
      found = true;
      const c = pickNum(count);
      if (c != null) n += c;
    }
  }
  return found ? n : 0;
}

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const items = pickNum(doc.summary?.items);
  if (items == null) return null;
  const gdps = sectionCount(doc, 'ground delay');
  const closures = sectionCount(doc, 'closure');
  const bits = [];
  if (gdps > 0) bits.push(`${gdps} ground-delay program${gdps === 1 ? '' : 's'}`);
  if (closures > 0) bits.push(`${closures} closure${closures === 1 ? '' : 's'}`);
  const what = bits.length ? bits.join(' · ') : 'no active programs';
  return withTags(`${EMOJI} FAA delays: ${what}`, doc);
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const sections = Array.isArray(doc.sections) ? doc.sections : [];
  const rows = [];
  for (const s of sections) {
    for (const it of s.items || []) {
      const f = it.fields || {};
      const dur = f.Avg || f.Max || '';
      const when = f.Start && f.Reopen ? ` ${f.Start} → ${f.Reopen}` : '';
      rows.push(`${it.airport} (${s.name}): ${f.Reason || 'no reason given'}${dur ? `, ${dur}` : ''}${when}`);
      if (rows.length >= 4) break;
    }
    if (rows.length >= 4) break;
  }
  const parts = [];
  if (rows.length) parts.push(rows.join(' · '));
  else parts.push('No active FAA delay programs, ground stops or closures at last update.');
  parts.push('Lists active programs only — a quiet board is real data, not a gap.');
  return parts.join(' ');
}
