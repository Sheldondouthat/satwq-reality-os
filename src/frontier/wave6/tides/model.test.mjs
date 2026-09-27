import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "station": "8638610",
  "waterLevel": [
    {
      "time": "2026-09-27T19:00:00Z",
      "feet": 2.34
    }
  ]
};

test('tides: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/tides');
});

test('tides: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('tides: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /2\.34 ft @ 8638610/);
});

test('tides: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /1 readings/);
});

test('tides: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
