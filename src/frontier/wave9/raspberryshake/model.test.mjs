/**
 * Wave 9 — Raspberry Shake ticker model tests (pure model, synthetic docs).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const DOC = {
  summary: { network: 'AM', totalStations: 7937, active: 6228, dark: 1709, newWeek: 12, retiredWeek: 5 },
  density: [
    { cell: '40,-80', count: 214 },
    { cell: '30,-100', count: 188 },
    { cell: '50,0', count: 171 },
  ],
};

test('ROUTE is /api/raspberryshake', () => {
  assert.equal(ROUTE, '/api/raspberryshake');
});

test('valueLine names active/total with thousands separators', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('6,228'), line);
  assert.ok(line.includes('7,937'), line);
  assert.ok(line.includes('listed active'), line);
});

test('valueLine returns null when the summary is missing', () => {
  assert.equal(valueLine({}), null);
  assert.equal(valueLine({ error: 'rs_unavailable' }), null);
});

test('detailLine names densest cells and weekly churn', () => {
  const line = detailLine(DOC);
  assert.ok(line.includes('40,-80'), line);
  assert.ok(line.includes('12 joined / 5 retired'), line);
  assert.ok(line.includes('not live data flow'), line);
});

test('detailLine degrades honestly on empty docs', () => {
  assert.equal(detailLine({}), 'Registry metadata, not live data flow — a listed-open station can be dark.');
});
