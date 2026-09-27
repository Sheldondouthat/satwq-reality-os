import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "generatedAt": "2026-09-27T19:00:00Z",
  "stale": false,
  "snapshot": {
    "fetchedAt": "2026-09-27T12:00:00Z"
  },
  "horizons": [
    {},
    {},
    {}
  ]
};

test('iconD2: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/icon-d2');
});

test('iconD2: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('iconD2: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /ICON-D2 · 3 horizons/);
});

test('iconD2: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /2026-09-27T12:00:00Z/);
});

test('iconD2: snapshot-pending state is honest', () => {
  const line = valueLine({ ...SAMPLE, snapshot: undefined, stale: true }) ?? '';
  assert.match(line, /snapshot pending/);
});
