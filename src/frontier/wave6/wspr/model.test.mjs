import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  count: 842,
  spots: [
    {
      id: 13651147969,
      time: '2026-11-15T07:12:00.000Z',
      txCall: 'DL2NL',
      txLat: 51.479,
      txLon: 6.958,
      rxCall: 'DL2NL/1',
      rxLat: 51.479,
      rxLon: 6.958,
      freqMHz: 10.1402,
      snrDb: 1,
      drift: 0,
      powerDbm: 23,
    },
  ],
};

test('wspr: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/wspr-live');
});

test('wspr: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('wspr: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /842 WSPR spots \(last hour\)/);
});

test('wspr: detailLine shows the newest spot as txCall→rxCall freq MHz', () => {
  assert.match(detailLine(SAMPLE), /DL2NL→DL2NL\/1/);
  assert.match(detailLine(SAMPLE), /10\.1402 MHz/);
});

test('wspr: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
