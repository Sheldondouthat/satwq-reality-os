import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "sources": {
    "irf": {
      "ok": true,
      "count": 6,
      "note": "manifest entries; image bytes load client-side"
    },
    "hapi": {
      "ok": true,
      "liveCount": 3,
      "requested": 4
    }
  }
};

test('magnetometers: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/magnetometers');
});

test('magnetometers: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('magnetometers: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /IRF 6 plots/);
});

test('magnetometers: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /client-side/);
});

test('magnetometers: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
