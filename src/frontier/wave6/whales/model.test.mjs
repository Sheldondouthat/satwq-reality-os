import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 42,
  "detections": [
    {
      "species": "Megaptera novaeangliae"
    }
  ],
  "platforms": [
    "happywhale"
  ]
};

test('whales: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/whales');
});

test('whales: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('whales: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /42 whale detections/);
});

test('whales: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Megaptera/);
});

test('whales: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
