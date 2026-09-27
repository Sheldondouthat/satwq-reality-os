import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "title": "BirdCast Migration Dashboard",
  "probe": "ok",
  "embedUrl": "https://dashboard.birdcast.info"
};

test('birdcastDash: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/birdcast-dash');
});

test('birdcastDash: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('birdcastDash: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /BirdCast migration dashboard/);
});

test('birdcastDash: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /probe ok/);
});

test('birdcastDash: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
