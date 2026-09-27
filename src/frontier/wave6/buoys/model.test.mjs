import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 200,
  "buoys": [
    {
      "id": "41001"
    },
    {
      "id": "41002"
    }
  ]
};

test('buoys: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/buoys');
});

test('buoys: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('buoys: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /200 buoys reporting/);
});

test('buoys: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /41001/);
});

test('buoys: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
