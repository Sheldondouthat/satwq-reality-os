import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

test('ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/goes');
});

test('valueLine: fresh/total with dark bit', () => {
  const line = valueLine({ summary: { fresh: 2, total: 4, dark: 2 } });
  assert.ok(line.includes('GOES 2/4 sats fresh'), line);
  assert.ok(line.includes('2 dark'), line);
  assert.ok(line.includes('full-disk'), line);
});

test('valueLine: no dark bit when all operational', () => {
  const line = valueLine({ summary: { fresh: 2, total: 2, dark: 0 } });
  assert.ok(!line.includes('dark'), line);
});

test('valueLine: null on missing summary or unavailable doc', () => {
  assert.equal(valueLine({}), null);
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ error: 'goes_unavailable' }), null);
});

test('detailLine: latest scans + honesty note', () => {
  const d = detailLine({
    satellites: [
      { sat: 'G18', dark: false, latestScan: '2026-09-30T07:30:20.000Z' },
      { sat: 'G16', dark: true, latestScan: null },
    ],
  });
  assert.ok(d.includes('G18 07:30Z'), d);
  assert.ok(!d.includes('G16'), d);
  assert.ok(d.includes('not a rendered picture'), d);
});

test('detailLine: empty string on unavailable doc', () => {
  assert.equal(detailLine(null), '');
});
