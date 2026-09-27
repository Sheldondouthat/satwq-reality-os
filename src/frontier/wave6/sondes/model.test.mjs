import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 50,
  "airborne": 12,
  "sondes": [
    {
      "serial": "S1234567",
      "altM": 8234,
      "uploader": "OE1ABC"
    }
  ]
};

test('sondes: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/sondes');
});

test('sondes: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('sondes: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /12\/50 radiosondes airborne/);
});

test('sondes: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /S1234567/);
});

test('sondes: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
