import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 7,
  "sources": {
    "avo": {
      "ok": true
    }
  },
  "cams": [
    {
      "url": "https://example.com/cam1.jpg",
      "name": "Redoubt"
    }
  ]
};

test('volcanoCams: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/volcano-cams');
});

test('volcanoCams: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('volcanoCams: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /7 volcano cams/);
});

test('volcanoCams: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Redoubt/);
});

test('volcanoCams: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
