import assert from 'node:assert/strict';
import test from 'node:test';
import { authorLine, feedGlyph, feedLabel, pubYear, workSubtitle } from './model.js';

test('feedLabel maps known research feeds', () => {
  assert.equal(feedLabel('openalex'), 'OpenAlex');
  assert.equal(feedLabel('pubmed'), 'PubMed');
  assert.equal(feedLabel('arxiv'), 'arXiv');
  assert.equal(feedLabel('bogus'), 'bogus');
});

test('feedGlyph returns a glyph for known feeds', () => {
  assert.ok(feedGlyph('crossref').length > 0);
  assert.equal(feedGlyph('bogus'), '•');
});

test('authorLine truncates with +more', () => {
  assert.equal(authorLine(['A', 'B']), 'A, B');
  assert.equal(authorLine(['A', 'B', 'C', 'D']), 'A, B, C +1 more');
  assert.equal(authorLine([]), '');
  assert.equal(authorLine(null), '');
});

test('pubYear extracts leading year', () => {
  assert.equal(pubYear('2026-01-15'), '2026');
  assert.equal(pubYear('2026 Feb'), '2026');
  assert.equal(pubYear(null), 'n/a');
  assert.equal(pubYear('soon'), 'n/a');
});

test('workSubtitle joins authors, venue, year, alsoSeen', () => {
  const s = workSubtitle({
    authors: ['Ada L'],
    venue: 'Astrophys J',
    published: '2026-01-15',
    alsoSeen: ['crossref'],
  });
  assert.ok(s.includes('Ada L'));
  assert.ok(s.includes('Astrophys J'));
  assert.ok(s.includes('2026'));
  assert.ok(s.includes('also in Crossref'));
});

test('workSubtitle tolerates sparse works', () => {
  assert.equal(workSubtitle({}), '');
  assert.equal(workSubtitle(null), '');
});
