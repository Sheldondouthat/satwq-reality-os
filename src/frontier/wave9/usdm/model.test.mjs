import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

test('ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/usdm');
});

test('valueLine: D1+ share with D3+ and population bits', () => {
  const line = valueLine({
    summary: { d1PlusAreaPercent: 49.65, d3PlusAreaPercent: 10.17, populationInDrought: 105567337.82 },
  });
  assert.ok(line.includes('49.65% of US in drought (D1+)'), line);
  assert.ok(line.includes('D3+ 10.17%'), line);
  assert.ok(line.includes('106M people'), line);
});

test('valueLine: null on missing summary or unavailable doc', () => {
  assert.equal(valueLine({}), null);
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'usdm_unavailable' }), null);
});

test('detailLine: cumulative note + WoW deltas', () => {
  const d = detailLine({
    mapDate: '2026-09-22',
    categories: [
      { level: 'D1', areaPercent: 49.65, wowDeltaPctPoints: -0.12 },
      { level: 'D4', areaPercent: 1.77, wowDeltaPctPoints: 0.09 },
    ],
  });
  assert.ok(d.includes('2026-09-22'), d);
  assert.ok(d.includes('D1 49.65% (-0.12 pts WoW)'), d);
  assert.ok(d.includes('D4 1.77% (+0.09 pts WoW)'), d);
  assert.ok(d.includes('cumulative'), d);
  assert.ok(d.includes('D0/None not reported'), d);
});

test('detailLine: empty string on unavailable doc', () => {
  assert.equal(detailLine(null), '');
});
