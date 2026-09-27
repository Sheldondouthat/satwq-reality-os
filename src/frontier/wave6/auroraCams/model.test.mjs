import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 4,
  "cams": [
    {
      "url": "https://auroramax.phys.ucalgary.ca/recent/recent_480p.jpg",
      "name": "AuroraMAX",
      "probe": "ok"
    }
  ]
};

test('auroraCams: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/aurora-cams');
});

test('auroraCams: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('auroraCams: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /4 aurora cams/);
});

test('auroraCams: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /AuroraMAX/);
});

test('auroraCams: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
