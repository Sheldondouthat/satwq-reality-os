/**
 * Wave 9 — mempool.space ticker model tests (synthetic doc, pure model).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { valueLine, detailLine, ROUTE } from './model.js';

const DOC = {
  generatedAt: '2026-10-03T11:50:00.000Z',
  stale: false,
  height: 969740,
  tip: { height: 969740, timestamp: 1791040909, txCount: 4071, sizeBytes: 1578130 },
  fees: { fastest: 6, halfHour: 5, hour: 4, economy: 2, minimum: 1 },
  mempool: { txCount: 84809, vsizeBytes: 44631960, totalFeeSats: 19528260 },
};

test('route is the mempool endpoint', () => {
  assert.equal(ROUTE, '/api/mempool');
});

test('valueLine names the block, the fee tiers, and the queue', () => {
  const line = valueLine(DOC);
  assert.match(line, /block 969,740/);
  assert.match(line, /fees 6\/5\/4 sat\/vB/);
  assert.match(line, /84\.8K tx waiting/);
});

test('valueLine returns null on unavailable payloads', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'mempool_unavailable' }), null);
  assert.equal(valueLine({}), null);
});

test('valueLine degrades gracefully with partial data', () => {
  const line = valueLine({ height: 969740, fees: null, mempool: null });
  assert.match(line, /block 969,740/);
  assert.doesNotMatch(line, /fees/);
});

test('detailLine carries tip block, fees, and mempool with honesty', () => {
  const d = detailLine(DOC);
  assert.match(d, /Tip block 969,740/);
  assert.match(d, /4,071 txs/);
  assert.match(d, /fastest 6/);
  assert.match(d, /projections, not guarantees/);
  assert.match(d, /84\.8K transactions waiting/);
  assert.match(d, /44\.6 MB virtual/);
  assert.match(d, /no fiat/);
});

test('detailLine returns empty string on unavailable', () => {
  assert.equal(detailLine(null), '');
});
