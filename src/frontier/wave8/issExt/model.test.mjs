import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "iss": {
    "ok": true,
    "latitude": 41.2,
    "longitude": -80.7,
    "dataAgeMs": 45000
  },
  "astros": {
    "ok": true,
    "number": 7
  }
};

test('issExt: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/iss-ext');
});

test('issExt: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('issExt: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /ISS 41\.2°, -80\.7°/);
});

test('issExt: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /position age 45s/);
});

test('issExt: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
