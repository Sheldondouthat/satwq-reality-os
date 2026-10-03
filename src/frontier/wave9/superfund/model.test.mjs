/**
 * Wave 9 — EPA Superfund NPL sites — ticker model tests (pure).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const DOC = {
  generatedAt: '2026-10-02T12:00:00Z',
  stale: false,
  scope: { status: 'A', state: 'national' },
  summary: {
    total: 1349,
    byStatus: { final: 1337, proposed: 12 },
    topStates: [
      { state: 'NJ', count: 115 },
      { state: 'CA', count: 97 },
      { state: 'PA', count: 91 },
    ],
  },
  sites: [],
};

test('ROUTE/EMOJI/LABEL identity', () => {
  assert.equal(ROUTE, '/api/superfund');
  assert.equal(EMOJI, '☣️');
  assert.equal(LABEL, 'Superfund NPL sites');
});

test('valueLine: total + top state', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('☣️'), line);
  assert.ok(line.includes('1349 sites'), line);
  assert.ok(line.includes('NJ (115)'), line);
});

test('valueLine: null when summary missing', () => {
  assert.equal(valueLine({}), null);
});

test('detailLine: final/proposed split + top states + honesty', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('Final NPL 1337'), line);
  assert.ok(line.includes('proposed 12'), line);
  assert.ok(line.includes('NJ 115'), line);
  assert.ok(line.includes('not a cleanup-status readout'), line);
});
