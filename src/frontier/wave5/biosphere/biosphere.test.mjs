import assert from 'node:assert/strict';
import test from 'node:test';
import { feedGlyph, feedLabel, hasCoords, observationSubtitle, observationsWithCoords, taxonColor } from './model.js';

const OBS = [
  { id: '1', feed: 'inaturalist', name: 'Monarch', scientificName: 'Danaus plexippus', lat: 37.2, lon: -80.5, observed: '2026-09-27', observer: 'sheldon', license: 'CC-BY-NC', iconicTaxon: 'Insecta' },
  { id: '2', feed: 'gbif', name: 'Bald Eagle', scientificName: 'Haliaeetus leucocephalus', lat: null, lon: null, observed: '2026-09-26', observer: 'ds', license: 'CC0' },
  { id: '3', feed: 'gbif', name: 'Red Fox', scientificName: 'Vulpes vulpes', lat: 38.1, lon: -79.9, observed: '2026-09-25' },
];

test('feedLabel maps known biosphere feeds', () => {
  assert.equal(feedLabel('inaturalist'), 'iNaturalist');
  assert.equal(feedLabel('gbif'), 'GBIF');
  assert.equal(feedLabel('bogus'), 'bogus');
});

test('feedGlyph returns a glyph for known feeds', () => {
  assert.ok(feedGlyph('inaturalist').length > 0);
  assert.equal(feedGlyph('bogus'), '•');
});

test('taxonColor maps known taxa, defaults for unknown', () => {
  assert.equal(taxonColor('Insecta'), '#ffb454');
  assert.equal(taxonColor('AVES'), '#7ad7ff');
  assert.equal(taxonColor('unknown taxon'), '#8ae6e6');
  assert.equal(taxonColor(null), '#8ae6e6');
});

test('hasCoords requires finite lat and lon', () => {
  assert.equal(hasCoords(OBS[0]), true);
  assert.equal(hasCoords(OBS[1]), false);
  assert.equal(hasCoords({}), false);
  assert.equal(hasCoords(null), false);
});

test('observationsWithCoords filters and sorts newest-first', () => {
  const pts = observationsWithCoords(OBS);
  assert.equal(pts.length, 2);
  assert.equal(pts[0].id, '1'); // newest observed first
  assert.equal(pts[1].id, '3');
});

test('observationSubtitle skips name==scientificName dup and joins fields', () => {
  const s = observationSubtitle(OBS[0]);
  assert.ok(s.includes('Danaus plexippus'));
  assert.ok(s.includes('2026-09-27'));
  assert.ok(s.includes('sheldon'));
  const dup = observationSubtitle({ name: 'x', scientificName: 'x', observed: '2026-01-01' });
  assert.equal(dup, '2026-01-01');
  assert.equal(observationSubtitle(null), '');
});
