import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "generatedAt": "2026-09-27T19:00:00Z",
  "stale": false,
  "observatory": {
    "code": "BOU"
  },
  "latestValid": {
    "t": "2026-09-27T18:59:00Z",
    "h": 21034.5,
    "d": 8.2
  }
};

test('geomagUsgs: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/geomag-usgs');
});

test('geomagUsgs: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('geomagUsgs: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /BOU H 21034\.5 nT/);
});

test('geomagUsgs: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /2026-09-27T18:59:00Z/);
});

test('geomagUsgs: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
