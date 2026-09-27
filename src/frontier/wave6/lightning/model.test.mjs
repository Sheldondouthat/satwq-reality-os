import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 5000,
  "strikes": [
    {
      "lat": 37.2,
      "lon": -80.7,
      "time": "2026-09-27T23:50:33.644Z"
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
