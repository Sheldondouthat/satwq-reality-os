import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 8,
  "attribution": "NOAA Coral Reef Watch",
  "animations": [
    {
      "url": "https://example.com/crb.gif",
      "name": "Caribbean"
    }
  ]
};

test('coral: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/coral');
});

test('coral: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('coral: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /8 coral-bleaching animations/);
});

test('coral: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Coral Reef Watch/);
});

test('coral: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
