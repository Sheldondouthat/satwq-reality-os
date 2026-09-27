import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 3000,
  "systems": {
    "nyc": {
      "ok": true
    }
  },
  "stations": [
    {
      "name": "Broadway & W 53 St"
    }
  ]
};

test('bikeshare: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/bikeshare');
});

test('bikeshare: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('bikeshare: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /3,000 bikeshare stations/);
});

test('bikeshare: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Broadway/);
});

test('bikeshare: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
