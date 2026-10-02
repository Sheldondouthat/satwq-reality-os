/**
 * Wave 9 — OCEARCH shark tracker — ticker model tests (pure).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, EMOJI, LABEL, valueLine, detailLine } from './model.js';

const DOC = {
  generatedAt: '2026-10-02T07:00:00Z',
  stale: false,
  summary: { animals: 12, ok: 12, dark: 0, fresh: 2, sharksInMap: 399, freshestPingUtc: '2026-09-30T23:39:01.318000Z' },
  animals: [
    { id: 3470603, name: 'Toño', species: 'Tiger Shark (Galeocerdo cuvier)', ok: true, lastPing: '2026-09-30T23:39:01.318000Z', lastPingAgeDays: 1.3 },
    { id: 544541, name: 'Breton', species: 'White Shark (Carcharodon carcharias)', ok: true, lastPing: '2026-09-29T13:29:56.844000Z', lastPingAgeDays: 2.4 },
    { id: 288211, name: 'Grey Lady', species: 'White Shark (Carcharodon carcharias)', ok: true, lastPing: '2018-12-30T10:28:52Z', lastPingAgeDays: 2825.2 },
  ],
};

test('ROUTE/EMOJI/LABEL identity', () => {
  assert.equal(ROUTE, '/api/ocearch');
  assert.equal(EMOJI, '🦈');
  assert.equal(LABEL, 'OCEARCH shark tracks');
});

test('valueLine: counts + fresh bit', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('🦈'), line);
  assert.ok(line.includes('12/12'), line);
  assert.ok(line.includes('2 fresh'), line);
});

test('valueLine null on unavailable / unusable payloads', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'ocearch_unavailable' }), null);
  assert.equal(valueLine({ summary: {} }), null);
});

test('detailLine: names the freshest pings, states the honesty limits', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('Toño'), line);
  assert.ok(line.includes('Breton'), line);
  assert.ok(line.includes('z-pings have no location'), line);
  assert.ok(line.includes('not the true path'), line);
  assert.equal(detailLine(null), '');
});
