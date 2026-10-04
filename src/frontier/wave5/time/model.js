/**
 * Wave 5 — leap-second / time-standard ticker client model (pure, no DOM).
 *
 * HONESTY: nextLeap === null is the normal state (no leap announced), not
 * an error. agreement 'disagree' means the dock must say IERS won.
 */

const API = '/api/time';

export function formatTaiUtc(v) {
  if (!Number.isFinite(v)) return 'TAI−UTC: unknown';
  return `TAI−UTC = ${v} s`;
}

export function leapLine(nextLeap) {
  if (!nextLeap) return 'no leap second announced';
  const date = nextLeap.date ?? 'unknown date';
  const by = nextLeap.announcedBy ? ` (${nextLeap.announcedBy})` : '';
  const off = Number.isFinite(nextLeap.taiMinusUtc)
    ? ` → TAI−UTC ${nextLeap.taiMinusUtc} s`
    : '';
  return `next leap: ${date}${by}${off}`;
}

export function tickerLine(doc) {
  if (!doc || doc.unavailable) return '🕰 time standards unavailable';
  const parts = [`🕰 ${formatTaiUtc(doc.taiMinusUtc)}`, leapLine(doc.nextLeap)];
  if (doc.agreement === 'disagree')
    parts.push('⚠ IERS/IANA disagree — IERS shown');
  if (doc.stale) parts.push('(stale)');
  return parts.join(' · ');
}

export async function fetchTime(fetchImpl = fetch) {
  const res = await fetchImpl(API);
  if (!res.ok) throw new Error(`time_http_${res.status}`);
  const doc = await res.json();
  if (!doc || typeof doc !== 'object') throw new Error('time_unexpected_shape');
  return doc;
}
