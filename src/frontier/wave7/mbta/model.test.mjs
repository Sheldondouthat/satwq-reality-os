import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 180,
  "vehicles": [
    {
      "route": "Red",
      "label": "0187"
    }
  ]
};

test('mbta: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/mbta');
});

test('mbta: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('mbta: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /180 MBTA vehicles/);
});

test('mbta: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Red/);
});

test('mbta: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
