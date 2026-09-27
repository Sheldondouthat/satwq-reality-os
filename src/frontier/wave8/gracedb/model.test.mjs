import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "total": 10,
  "returned": 10,
  "realCount": 2,
  "mockCount": 8,
  "allRecentAreMock": false,
  "disclaimer": "Mock Data Challenge events are labeled mock:true"
};

test('gracedb: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/gracedb');
});

test('gracedb: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('gracedb: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /GraceDB 2 real/);
});

test('gracedb: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Mock Data Challenge/);
});

test('gracedb: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
