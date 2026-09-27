import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "generatedAt": "2026-09-27T19:00:00Z",
  "stale": false,
  "station": {
    "network": "IM",
    "station": "I53H1",
    "lat": 60.1,
    "lon": 10.2
  },
  "stats": {}
};

test('infrasound: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/infrasound-ims');
});

test('infrasound: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('infrasound: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /IMS I53H1 infrasound/);
});

test('infrasound: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /IM/);
});

test('infrasound: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
