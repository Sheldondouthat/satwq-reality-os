/**
 * Wave 5 / Track A — EMSC felt-earthquake client model (pure, no Cesium).
 *
 * HONESTY: testimonyCount is crowd-sourced — self-reported "I felt it"
 * testimonies, NOT an instrumental intensity (MMI) measurement. Point size
 * encodes testimony volume, not shaking strength; every label says so.
 */

/** Globe point pixel size from testimony count: 6–26 px, sqrt-scaled. */
export function testimonySize(testimonyCount) {
  const tc = Number.isFinite(testimonyCount) ? testimonyCount : 0;
  return Math.min(26, Math.max(6, 6 + Math.sqrt(Math.max(0, tc)) * 2));
}

/** Point color by magnitude (instrumental) — testimony stays in the size channel. */
export function magColor(mag) {
  if (!Number.isFinite(mag)) return '#8a93a6';
  if (mag < 3.5) return '#9fb3d6';
  if (mag < 4.5) return '#ffb454';
  if (mag < 5.5) return '#ff7a3d';
  return '#ff5a5a';
}

/** Human relative age, e.g. "2h ago", "3d ago". */
export function formatAge(timeMs, now = Date.now()) {
  if (!Number.isFinite(timeMs)) return 'time unknown';
  const diff = Math.max(0, now - timeMs);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Dock label: magnitude + testimony count + age. */
export function feltLabel(event, now = Date.now()) {
  const mag = Number.isFinite(event.mag) ? `M${event.mag.toFixed(1)}` : 'M?';
  const tc = Number.isFinite(event.testimonyCount) ? event.testimonyCount : 0;
  const who = tc === 1 ? 'testimony' : 'testimonies';
  return `${mag} · ${tc} ${who} · ${formatAge(event.timeMs, now)}`;
}

/** Top-n events by testimony volume. */
export function topFelt(events, n = 10) {
  return [...(events ?? [])]
    .filter((e) => Number.isFinite(e.testimonyCount))
    .sort((a, b) => b.testimonyCount - a.testimonyCount)
    .slice(0, n);
}
