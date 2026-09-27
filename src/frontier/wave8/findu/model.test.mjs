import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "callsign": "K1JT",
  "hasReports": true,
  "fields": {
    "temperature": "18.2 C",
    "humidity": "64%"
  },
  "pageUrl": "https://www.findu.com/cgi-bin/find.cgi?call=K1JT"
};

test('findu: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/findu');
});

test('findu: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('findu: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /K1JT: position reports/);
});

test('findu: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /temp 18\.2 C/);
});

test('findu: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
