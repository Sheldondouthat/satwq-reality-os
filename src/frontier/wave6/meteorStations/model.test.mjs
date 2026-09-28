import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 128,
  "stations": [
    { "station": "BEONRD", "code": "BEONRD", "count": 24, "totalCount": 96, "hourly": [] },
    { "station": "BEHUMA", "code": "BEHUMA", "count": 8, "totalCount": 32, "hourly": [] }
  ]
};

test('meteorStations: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/meteor-stations');
});

test('meteorStations: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('meteorStations: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /128 radio meteors/);
  assert.match(line, /2 stations/);
});

test('meteorStations: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /BEONRD/);
});

test('meteorStations: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
