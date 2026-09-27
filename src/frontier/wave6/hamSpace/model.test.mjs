import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "sources": {
    "ariss": {
      "ok": true
    },
    "ecallisto": {
      "ok": false,
      "error": "timeout"
    }
  },
  "ariss": {
    "status": "crew on air"
  },
  "ecallisto": {}
};

test('hamSpace: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/ham-space');
});

test('hamSpace: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('hamSpace: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /1\/2 sources live/);
});

test('hamSpace: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /crew on air/);
});

test('hamSpace: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
