/**
 * Wave 9 — alert rules ticker model (pure, no DOM).
 *
 * Ticker model (pure, no DOM) for GET /api/alert-rules.
 *
 * HONESTY: rule tripwires are ours (heuristic thresholds), not the agencies'
 * official alert products — MIROVA levels excepted (MIROVA's own). valueLine
 * names the firing count; quiet-is-real when every rule is ok and empty.
 */
import { isUnavailable, withTags, pickNum } from '../../wave3/common/ticker.js';

export const ROUTE = '/api/alert-rules';
export const EMOJI = '🚨';
export const LABEL = 'Alert rules (ntfy push)';

export function valueLine(doc) {
  if (isUnavailable(doc)) return null;
  const firingCount = pickNum(doc.firingCount);
  if (firingCount == null) return null;
  if (firingCount === 0) {
    const rules = Array.isArray(doc.rules) ? doc.rules.length : 0;
    const ok = Array.isArray(doc.rules)
      ? doc.rules.filter((r) => r.ok).length
      : 0;
    return withTags(
      `${EMOJI} Alert rules: quiet — 0 firing (${ok}/${rules} rules ok)`,
      doc,
    );
  }
  const top =
    Array.isArray(doc.firings) && doc.firings.length > 0
      ? doc.firings[0].title
      : null;
  const extra = firingCount > 1 ? ` (+${firingCount - 1} more)` : '';
  return withTags(
    `${EMOJI} Alert rules: ${firingCount} firing${firingCount === 1 ? '' : 's'}${top ? ` — ${top}${extra}` : ''}`,
    doc,
  );
}

export function detailLine(doc) {
  if (isUnavailable(doc)) return '';
  const firings = Array.isArray(doc.firings) ? doc.firings : [];
  const parts = firings.slice(0, 5).map((f) => `[${f.severity}] ${f.title}`);
  parts.push(
    'Tripwires are heuristic thresholds, not official agency alerts (MIROVA levels excepted).',
  );
  const topic = doc.notify?.topic;
  if (topic)
    parts.push(`Push: subscribe to ntfy.sh topic "${topic}" in the ntfy app.`);
  return parts.join(' ');
}
