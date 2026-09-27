import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 12,
  "comets": [
    {
      "designation": "C/2025 A6"
    }
  ],
  "observations": [
    {},
    {}
  ]
};

test('comets: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/comets');
});

test('comets: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('comets: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /12 comets/);
});

test('comets: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /C\/2025 A6/);
});

test('comets: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
