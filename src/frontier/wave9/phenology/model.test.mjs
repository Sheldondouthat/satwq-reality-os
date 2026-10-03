/**
 * Wave 9 — phenology ticker model tests (synthetic doc, pure model).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { valueLine, detailLine, ROUTE } from './model.js';

const DOC = {
  generatedAt: '2026-10-03T12:00:00.000Z',
  stale: false,
  points: [
    { id: 'pembroke-va', label: 'Pembroke VA (home)', lat: 37.32, lon: -80.74, ok: true, leafAnomalyDays: -7, bloomAnomalyDays: -13 },
    { id: 'seattle-wa', label: 'Seattle WA', lat: 47.61, lon: -122.33, ok: true, leafAnomalyDays: 0, bloomAnomalyDays: 2 },
  ],
};

test('route is the phenology endpoint', () => {
  assert.equal(ROUTE, '/api/phenology');
});

test('valueLine renders early/late/on-time per point', () => {
  const line = valueLine(DOC);
  assert.match(line, /pembroke-va: leaf 7d early, bloom 13d early/);
  assert.match(line, /seattle-wa: leaf on time, bloom 2d late/);
});

test('valueLine returns null on unavailable payloads', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'pheno_unavailable' }), null);
  assert.equal(valueLine({ points: [] }), null);
  assert.equal(valueLine({ points: [{ ok: false }] }), null);
});

test('detailLine names points and the model-not-observations honesty note', () => {
  const d = detailLine(DOC);
  assert.match(d, /Pembroke VA \(home\): leaf 7d early, bloom 13d early/);
  assert.match(d, /model.*not direct observations/);
});

test('detailLine returns empty string on unavailable', () => {
  assert.equal(detailLine(null), '');
});
