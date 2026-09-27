import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "productCount": 6,
  "partial": false,
  "products": [
    {
      "stormId": "AL092026",
      "filename": "al092026_5day_001.zip"
    }
  ]
};

test('nhcGis: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/nhc-gis');
});

test('nhcGis: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('nhcGis: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /6 NHC GIS products/);
});

test('nhcGis: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /AL092026/);
});

test('nhcGis: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
