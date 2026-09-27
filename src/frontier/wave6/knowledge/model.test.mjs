import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "items": [
    {
      "kind": "wiki",
      "headline": "Ada Lovelace"
    },
    {
      "kind": "wb",
      "headline": "Q42"
    }
  ]
};

test('knowledge: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/knowledge');
});

test('knowledge: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('knowledge: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /2 knowledge cards/);
});

test('knowledge: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Ada Lovelace/);
});

test('knowledge: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
