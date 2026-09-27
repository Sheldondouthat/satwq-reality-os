import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "generatedAt": "2026-09-27T19:00:00Z",
  "stale": true,
  "snapshot": {
    "fetchedAt": "2026-09-27T10:00:00Z"
  },
  "regions": [
    {
      "name": "usegc"
    },
    {
      "name": "gak"
    }
  ]
};

test('currents: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/currents');
});

test('currents: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('currents: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /HF-radar currents · 2 regions/);
});

test('currents: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /usegc/);
});

test('currents: snapshot-pending state is honest', () => {
  const line = valueLine({ ...SAMPLE, snapshot: undefined, stale: true }) ?? '';
  assert.match(line, /snapshot pending/);
});
