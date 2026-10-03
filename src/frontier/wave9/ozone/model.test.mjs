/**
 * Wave 9 — ozone ticker model tests (synthetic doc, pure model).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { valueLine, detailLine, ROUTE } from './model.js';

const DOC = {
  generatedAt: '2026-10-03T12:00:00.000Z',
  stale: false,
  latest: {
    year: 2025,
    maxHoleArea: { valueMkm2: 22.9, date: '2025-09-09' },
    minOzone: { valueDU: 127, date: '2025-09-25' },
  },
  records: {
    largestHole: { valueMkm2: 29.9, date: '2000-09-09', year: 2000 },
    lowestOzone: { valueDU: 73, date: '1994-09-30', year: 1994 },
  },
};

test('route is the ozone endpoint', () => {
  assert.equal(ROUTE, '/api/ozone');
});

test('valueLine names the latest year, hole area, and min ozone', () => {
  const line = valueLine(DOC);
  assert.match(line, /2025/);
  assert.match(line, /hole 22\.9M km²/);
  assert.match(line, /min 127 DU/);
});

test('valueLine returns null on unavailable payloads', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'ozone_unavailable' }), null);
  assert.equal(valueLine({ latest: null }), null);
});

test('detailLine carries records and the annual-only honesty note', () => {
  const d = detailLine(DOC);
  assert.match(d, /29\.9M km² in 2000/);
  assert.match(d, /73 DU in 1994/);
  assert.match(d, /Annual maxima/);
});

test('detailLine returns empty string on unavailable', () => {
  assert.equal(detailLine(null), '');
});
