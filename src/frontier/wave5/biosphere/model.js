/**
 * Wave 5 — Biosphere ticker client model (pure, no Cesium).
 *
 * Pure presentation + globe-point helpers for the /api/biosphere
 * dock ticker. Observations carrying lat/lon become globe points.
 */

export const FEED_LABELS = {
  inaturalist: 'iNaturalist',
  gbif: 'GBIF',
};

export const FEED_GLYPHS = {
  inaturalist: '🌿',
  gbif: '🌍',
};

/** Point color by iconic taxon / class. Unknown → soft cyan. */
const TAXON_COLORS = {
  insecta: '#ffb454',
  aves: '#7ad7ff',
  mammalia: '#ff8a8a',
  plantae: '#7ddf8a',
  reptilia: '#c4a2ff',
  amphibia: '#8ae0c8',
  fungi: '#e0b58a',
  animalia: '#9fb7ff',
};

export function feedLabel(feed) {
  return FEED_LABELS[feed] ?? String(feed ?? 'unknown');
}

export function feedGlyph(feed) {
  return FEED_GLYPHS[feed] ?? '•';
}

export function taxonColor(iconicTaxon) {
  const key = String(iconicTaxon ?? '').toLowerCase();
  return TAXON_COLORS[key] ?? '#8ae6e6';
}

/** True when the observation carries finite lat/lon. */
export function hasCoords(obs) {
  return Number.isFinite(obs?.lat) && Number.isFinite(obs?.lon);
}

/** Filter to coord-bearing observations, newest-first by observed. */
export function observationsWithCoords(items) {
  return (Array.isArray(items) ? items : [])
    .filter(hasCoords)
    .slice()
    .sort((a, b) =>
      String(b.observed ?? '').localeCompare(String(a.observed ?? '')),
    );
}

/** One-line dock subtitle for an observation. */
export function observationSubtitle(obs) {
  const parts = [];
  if (obs?.scientificName && obs.scientificName !== obs.name)
    parts.push(obs.scientificName);
  if (obs?.observed) parts.push(String(obs.observed).slice(0, 10));
  if (obs?.observer) parts.push(obs.observer);
  if (obs?.license) parts.push(obs.license);
  return parts.join(' · ');
}
