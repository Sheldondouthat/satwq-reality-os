import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "date": "2026-09-27",
  "count": 1,
  "latest": {
    "lastModified": "2026-09-27T12:00:00Z"
  }
};

test('birdcast: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/birdcast');
});

test('birdcast: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('birdcast: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /BirdCast 2026-09-27/);
});

test('birdcast: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /2026-09-27T12:00:00Z/);
});

test('birdcast: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
