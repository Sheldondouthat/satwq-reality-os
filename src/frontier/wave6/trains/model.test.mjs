import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 150,
  "sources": {
    "a": {
      "ok": true
    }
  },
  "trains": [
    {
      "route": "NECR"
    }
  ]
};

test('trains: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/trains');
});

test('trains: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('trains: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /150 trains tracked/);
});

test('trains: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /NECR/);
});

test('trains: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
