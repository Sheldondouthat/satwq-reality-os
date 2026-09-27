import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 9,
  "attribution": "NASA SDO",
  "images": [
    {
      "url": "https://sdo.gsfc.nasa.gov/assets/img/latest/latest_1024_0193.jpg",
      "name": "SDO AIA 193"
    }
  ]
};

test('solarImg: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/solar-img');
});

test('solarImg: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('solarImg: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /9 solar images/);
});

test('solarImg: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /NASA SDO/);
});

test('solarImg: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
