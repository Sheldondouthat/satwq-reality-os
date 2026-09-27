import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "generatedAt": "2026-09-27T19:00:00Z",
  "stale": false,
  "snapshot": {
    "fetchedAt": "2026-09-27T18:00:00Z"
  },
  "stats": {}
};

test('tec: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/tec');
});

test('tec: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('tec: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /ionosphere TEC/);
});

test('tec: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /2026-09-27T18:00:00Z/);
});

test('tec: snapshot-pending state is honest', () => {
  const line = valueLine({ ...SAMPLE, snapshot: undefined, stale: true }) ?? '';
  assert.match(line, /snapshot pending/);
});
