import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "count": 356,
  "alerts": [
    {
      "headline": "Severe Thunderstorm Warning",
      "event": "SVR"
    }
  ]
};

test('alerts: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/alerts');
});

test('alerts: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('alerts: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /356 active alerts/);
});

test('alerts: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Severe Thunderstorm Warning/);
});

test('alerts: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
