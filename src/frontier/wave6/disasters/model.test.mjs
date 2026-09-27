import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 25,
  "declarations": [
    {
      "state": "HI",
      "designatedArea": "Hawaii County"
    }
  ]
};

test('disasters: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/disasters');
});

test('disasters: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('disasters: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /25 disaster declarations/);
});

test('disasters: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /HI/);
});

test('disasters: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
