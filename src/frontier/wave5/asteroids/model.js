/**
 * Wave 5 — JPL close-approach asteroid ticker client model (pure, no Cesium).
 *
 * The /api/asteroids snapshot carries trimmed CAD rows:
 * {des, cd, distAu, distLd, vRelKms, h}.
 *
 * HONESTY: `cd` (close-approach date) is UTC per the CAD API; H is absolute
 * magnitude — a brightness measure, NOT a diameter. The UI says both.
 */

/** Fetch the close-approach snapshot. Returns the parsed payload or throws. */
export async function fetchAsteroids({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/asteroids', { cache: 'no-store' });
  if (!response.ok) throw new Error(`asteroids_http_${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.approaches))
    throw new Error('asteroids_bad_payload');
  return payload;
}

/**
 * Parse a CAD `cd` value ("YYYY-MM-DD HH:MM:SS.sss", UTC per the API) to
 * epoch ms. Returns NaN when unparseable.
 */
export function parseCd(cd) {
  if (typeof cd !== 'string' || !cd) return NaN;
  const normalized =
    cd.trim().replace(' ', 'T') + (cd.includes('Z') ? '' : 'Z');
  const t = Date.parse(normalized);
  if (!Number.isFinite(t)) return NaN;
  return t;
}

/** Chronological sort by close-approach time (unparseable dates last). */
export function sortApproaches(approaches) {
  return [...(approaches ?? [])].sort((a, b) => {
    const ta = parseCd(a?.cd);
    const tb = parseCd(b?.cd);
    const va = Number.isFinite(ta) ? ta : Number.MAX_SAFE_INTEGER;
    const vb = Number.isFinite(tb) ? tb : Number.MAX_SAFE_INTEGER;
    return va - vb;
  });
}

/** Countdown/to-late string for a close-approach date: "in 2d 3h", "45m ago". */
export function approachDelta(cd, now = Date.now()) {
  const t = parseCd(cd);
  if (!Number.isFinite(t)) return 'date n/a';
  const diff = t - now;
  const future = diff >= 0;
  const abs = Math.abs(diff);
  const m = Math.floor(abs / 60_000);
  const h = Math.floor(abs / 3600_000);
  let body;
  if (m < 1) body = 'under a minute';
  else if (m < 60) body = `${m}m`;
  else if (h < 48) body = `${h}h ${Math.floor((abs % 3600_000) / 60_000)}m`;
  else body = `${Math.floor(h / 24)}d ${h % 24}h`;
  return future ? `in ${body}` : `${body} ago`;
}

/** Lunar-distance framing for the dock list: label + dot color. */
export function ldBadge(distLd) {
  if (!Number.isFinite(distLd))
    return { label: 'distance n/a', color: '#8a93a6' };
  if (distLd < 1) return { label: 'inside the Moon’s orbit', color: '#ff5a5a' };
  if (distLd < 5) return { label: 'very close (<5 LD)', color: '#ff9f43' };
  if (distLd < 20) return { label: 'near-Earth (<20 LD)', color: '#ffb454' };
  return { label: 'distant flyby', color: '#8aa4d6' };
}

/** Brightness class from absolute magnitude H. H is NOT a size — the label says so. */
export function brightnessClass(h) {
  if (!Number.isFinite(h)) return 'H unlisted';
  if (h <= 21) return 'bright (H ≤ 21)';
  if (h <= 25) return 'typical (H 21–25)';
  return 'faint (H > 25)';
}

/** "2026 AA · in 2d 3h" short line label for one approach. */
export function approachTitle(approach, now = Date.now()) {
  const des = approach?.des ? String(approach.des) : 'unnamed';
  return `${des} · ${approachDelta(approach?.cd, now)}`.slice(0, 140);
}

/** Format lunar distance: "0.481 LD". */
export function formatLd(distLd) {
  return Number.isFinite(distLd) ? `${distLd.toFixed(3)} LD` : '—';
}

/** Dock status summary: "12 approaches · next: 2026 AA in 2d 3h". */
export function windowSummary(payload, now = Date.now()) {
  const approaches = sortApproaches(payload?.approaches ?? []);
  const next = approaches.find(
    (a) => Number.isFinite(parseCd(a?.cd)) && parseCd(a.cd) >= now - 3600_000,
  );
  const nextText = next
    ? `${next.des ?? 'unnamed'} ${approachDelta(next.cd, now)}`
    : 'no dated approaches';
  return `${approaches.length} approaches · next: ${nextText}`;
}

/** Escape user-controlled strings for HTML description fields. */
export function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[c],
  );
}
