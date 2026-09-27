import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 300,
  "markers": [
    {
      "reg": "D-4711",
      "altM": 1500,
      "speedKmh": 95
    }
  ]
};

test('gliders: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/gliders');
});

test('gliders: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('gliders: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /300 gliders live/);
});

test('gliders: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /D-4711/);
});

test('gliders: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
