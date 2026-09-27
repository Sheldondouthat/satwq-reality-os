import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 8800,
  "sources": {
    "aiscast": {
      "ok": true
    }
  },
  "ships": [
    {
      "name": "EVER GIVEN",
      "mmsi": "353136000"
    }
  ]
};

test('ships: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/ships');
});

test('ships: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('ships: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /8,800 vessels tracked/);
});

test('ships: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /EVER GIVEN/);
});

test('ships: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
