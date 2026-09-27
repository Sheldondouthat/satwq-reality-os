import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "dishCount": 12,
  "dishes": [
    {
      "tracking": true
    },
    {
      "tracking": false
    }
  ],
  "activeSpacecraft": [
    {
      "spacecraft": "Voyager 1"
    }
  ]
};

test('dsn: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/dsn');
});

test('dsn: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('dsn: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /1\/2 dishes tracking/);
});

test('dsn: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Voyager 1/);
});

test('dsn: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
