import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "total": 9000,
  "shown": 50,
  "transmitters": [
    {
      "satellite": "ISS",
      "mode": "FM",
      "alive": true
    }
  ]
};

test('frequencies: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/frequencies');
});

test('frequencies: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('frequencies: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /50\/9,000 satellite transmitters/);
});

test('frequencies: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /ISS/);
});

test('frequencies: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
