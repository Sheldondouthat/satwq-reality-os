/**
 * Wave 5 — Civic ticker client model (pure, no Cesium).
 *
 * Pure presentation helpers for the /api/civic dock ticker.
 */

export const FEED_LABELS = {
  'federal-register': 'Federal Register',
  'hacker-news': 'Hacker News',
  'nyc-311': 'NYC 311',
};

export const FEED_GLYPHS = {
  'federal-register': '🏛️',
  'hacker-news': '📰',
  'nyc-311': '🗽',
};

export function feedLabel(feed) {
  return FEED_LABELS[feed] ?? String(feed ?? 'unknown');
}

export function feedGlyph(feed) {
  return FEED_GLYPHS[feed] ?? '•';
}

/** Human relative time for an ISO timestamp. Pure math, no locale date libs. */
export function timeAgo(iso, now = Date.now()) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'date n/a';
  const diff = now - ms;
  if (diff < 0) return 'upcoming';
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** One-line dock subtitle for a civic item. */
export function itemSubtitle(item) {
  const parts = [];
  if (item?.kind) parts.push(item.kind);
  if (item?.by) parts.push(`by ${item.by}`);
  if (Number.isFinite(item?.score)) parts.push(`${item.score} pts`);
  if (Number.isFinite(item?.comments)) parts.push(`${item.comments} comments`);
  if (item?.published) parts.push(timeAgo(item.published));
  return parts.join(' · ');
}
