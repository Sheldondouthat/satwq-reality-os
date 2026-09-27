/**
 * Wave 5 — Research ticker client model (pure, no Cesium).
 *
 * Pure presentation helpers for the /api/research dock ticker.
 */

export const FEED_LABELS = {
  openalex: 'OpenAlex',
  crossref: 'Crossref',
  pubmed: 'PubMed',
  arxiv: 'arXiv',
};

export const FEED_GLYPHS = {
  openalex: '🎓',
  crossref: '📚',
  pubmed: '🧬',
  arxiv: '📄',
};

export function feedLabel(feed) {
  return FEED_LABELS[feed] ?? String(feed ?? 'unknown');
}

export function feedGlyph(feed) {
  return FEED_GLYPHS[feed] ?? '•';
}

/** Join up to N authors; append "+k more". */
export function authorLine(authors, max = 3) {
  const names = (Array.isArray(authors) ? authors : []).filter((n) => n);
  if (!names.length) return '';
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max} more`;
}

/** Compact year for a published date. */
export function pubYear(published) {
  const m = String(published ?? '').match(/^(\d{4})/);
  return m ? m[1] : 'n/a';
}

/** One-line dock subtitle for a research work. */
export function workSubtitle(work) {
  const parts = [];
  const authors = authorLine(work?.authors);
  if (authors) parts.push(authors);
  if (work?.venue) parts.push(work.venue);
  const year = pubYear(work?.published);
  if (year !== 'n/a') parts.push(year);
  if (Array.isArray(work?.alsoSeen) && work.alsoSeen.length)
    parts.push(`also in ${work.alsoSeen.map(feedLabel).join(', ')}`);
  return parts.join(' · ');
}
