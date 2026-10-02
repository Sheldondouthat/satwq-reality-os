/**
 * Wave 9 — Great Lakes water levels — ticker model tests.
 *
 * Fixtures mirror the real /api/great-lakes payload shape (monthly means,
 * IGLD 1985 meters, feet converted ×3.28084).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const DOC = {
  generatedAt: '2026-10-01T00:00:00Z',
  stale: false,
  lakes: [
    {
      id: 'superior', name: 'Lake Superior', ok: true, datum: 'IGLD 1985',
      latest: { month: '2025-12', levelM: 183.27, levelFt: 601.28, lagMonths: 10 },
      anomaly: { levelFt: -0.09, vs: 'full-record mean 1918-01–2025-12' },
      fresh: true,
    },
    {
      id: 'erie', name: 'Lake Erie', ok: true, datum: 'IGLD 1985',
      latest: { month: '2025-12', levelM: 174.05, levelFt: 571.05, lagMonths: 10 },
      anomaly: { levelFt: 0.31, vs: 'full-record mean 1918-01–2025-12' },
      fresh: true,
    },
    { id: 'ontario', name: 'Lake Ontario', ok: false, error: 'greatlakes_fetch_failed', status: 502 },
  ],
  honesty: { monthlyMeans: 'not real-time' },
};

test('ROUTE is the mounted API route', () => {
  assert.equal(ROUTE, '/api/great-lakes');
});

test('valueLine headlines Superior with month + dark count', () => {
  const line = valueLine(DOC);
  assert.ok(line.includes('Great Lakes 2/3 lakes'), line);
  assert.ok(line.includes('Superior 601.28 ft (2025-12)'), line);
  assert.ok(line.includes('1 dark'), line);
  assert.ok(line.includes('monthly means'), line);
});

test('valueLine returns null when nothing usable', () => {
  assert.equal(valueLine({ lakes: [] }), null);
  assert.equal(valueLine({ error: 'greatlakes_unavailable' }), null);
});

test('detailLine lists per-lake level with anomaly sign', () => {
  const detail = detailLine(DOC);
  assert.ok(detail.includes('Lake Superior: 601.28 ft @ 2025-12 (-0.09 ft vs mean)'), detail);
  assert.ok(detail.includes('Lake Erie: 571.05 ft @ 2025-12 (+0.31 ft vs mean)'), detail);
  assert.ok(!detail.includes('Ontario'), detail); // dark lake excluded
});

test('detailLine is empty when unavailable', () => {
  assert.equal(detailLine({ error: 'x' }), '');
});
