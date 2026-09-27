import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "counts": {
    "incidents": 389,
    "detections": 2500
  },
  "fires": [
    {
      "name": "Cedar Creek",
      "kind": "incident"
    }
  ]
};

test('fires: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/fires');
});

test('fires: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('fires: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /389 incidents/);
});

test('fires: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Cedar Creek/);
});

test('fires: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
