/**
 * Wave 9 — FAA airport delays (NAS status) — ticker model tests (pure).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const DOC = {
  generatedAt: '2026-10-02T12:00:00Z',
  stale: false,
  summary: {
    sections: 2,
    items: 3,
    byType: { 'Ground Delay Programs': 1, 'Airport Closures': 2 },
    airports: ['BOS', 'LAX', 'PHL'],
  },
  sections: [
    {
      name: 'Ground Delay Programs',
      itemTag: 'Ground_Delay',
      items: [
        { airport: 'BOS', fields: { Reason: 'runway construction', Avg: '1 hour and 5 minutes', Max: '3 hours and 4 minutes' } },
      ],
    },
    {
      name: 'Airport Closures',
      itemTag: 'Airport',
      items: [
        { airport: 'LAX', fields: { Reason: '!LAX 05/277 AD AP CLSD TO NON SKED TRANSIENT GA ACFT', Start: 'May 27 at 18:26 UTC.', Reopen: 'May 28 at 16:00 UTC.' } },
        { airport: 'PHL', fields: { Reason: '!PHL 09/263 AD AP CLSD TO NON SKED ACFT WINGSPAN MORE THAN 214FT', Start: 'Sep 30 at 18:06 UTC.', Reopen: 'Oct 31 at 12:00 UTC.' } },
      ],
    },
  ],
};

const QUIET_DOC = {
  generatedAt: '2026-10-02T12:00:00Z',
  stale: false,
  summary: { sections: 0, items: 0, byType: {}, airports: [] },
  sections: [],
};

test('ROUTE/EMOJI/LABEL identity', () => {
  assert.equal(ROUTE, '/api/faa-delays');
  assert.equal(EMOJI, '🛫');
  assert.equal(LABEL, 'FAA airport delays');
});

test('valueLine: names the active program kinds', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('🛫'), line);
  assert.ok(line.includes('1 ground-delay program'), line);
  assert.ok(line.includes('2 closures'), line);
});

test('valueLine: quiet sky is honest, not blank', () => {
  const line = valueLine(QUIET_DOC);
  assert.ok(line.includes('no active programs'), line);
});

test('valueLine null on unavailable / unusable payloads', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'faadelays_unavailable' }), null);
  assert.equal(valueLine({ summary: {} }), null);
});

test('detailLine: names airports with verbatim FAA strings', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('BOS'), line);
  assert.ok(line.includes('runway construction'), line);
  assert.ok(line.includes('1 hour and 5 minutes'), line);
  assert.ok(line.includes('LAX'), line);
  assert.ok(line.includes('quiet board is real data'), line);
});

test('detailLine: quiet document says so explicitly', () => {
  const line = detailLine(QUIET_DOC);
  assert.ok(line.includes('No active FAA delay programs'), line);
});

test('detailLine empty on unavailable', () => {
  assert.equal(detailLine(null), '');
  assert.equal(detailLine({ error: 'faadelays_unavailable' }), '');
});
