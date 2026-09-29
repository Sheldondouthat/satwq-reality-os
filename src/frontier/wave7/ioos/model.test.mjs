import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "gliders": {
    "activeMissions": 14
  },
  "sensors": {
    "activeDatasets": 220
  },
  "coastwatch": {
    "activeProducts": 12
  },
  "sources": {
    "gliderdac": {
      "ok": true
    }
  }
};

test('ioos: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/ioos');
});

test('ioos: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('ioos: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /14 glider missions/);
  assert.match(line, /12 CoastWatch products/);
});

test('ioos: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /1\/1 sources live/);
});

test('ioos: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
