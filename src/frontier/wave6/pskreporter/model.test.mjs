import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 120,
  "reports": [
    {
      "sender": "K1JT",
      "receiver": "W1AW",
      "freqMHz": 14.074,
      "mode": "FT8"
    }
  ]
};

test('pskreporter: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/pskreporter');
});

test('pskreporter: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('pskreporter: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /120 reception reports/);
});

test('pskreporter: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /K1JT→W1AW/);
});

test('pskreporter: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
