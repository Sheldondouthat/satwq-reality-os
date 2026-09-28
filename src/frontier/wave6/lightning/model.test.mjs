import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

// Time-relative fixture: hardcoded timestamps rot (this test failed when the
// full suite's ~7min runtime pushed the sample past the "5m ago" assertion).
const SAMPLE = {
  "count": 5000,
  "strikes": [
    {
      "lat": 37.2,
      "lon": -80.7,
      "time": new Date(Date.now() - 5 * 60_000).toISOString()
    }
  ]
};

test('lightning: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/lightning');
});

test('lightning: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('lightning: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /5,000 strikes/);
});

test('lightning: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /5m ago/);
});

test('lightning: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
