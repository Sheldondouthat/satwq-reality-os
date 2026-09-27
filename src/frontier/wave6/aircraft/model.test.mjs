import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 4200,
  "sources": {
    "opensky": {
      "ok": true
    },
    "adsblol": {
      "ok": true
    }
  },
  "aircraft": [
    {
      "callsign": "DAL123"
    }
  ]
};

test('aircraft: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/aircraft');
});

test('aircraft: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('aircraft: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /4,200 aircraft tracked/);
});

test('aircraft: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /DAL123/);
});

test('aircraft: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
