import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "stationCount": 1200,
  "sources": {
    "dwd": {
      "ok": true
    }
  },
  "stations": [
    {
      "id": "KBCB",
      "name": "Blacksburg",
      "network": "IEM"
    }
  ]
};

test('stationsExt: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/stations-ext');
});

test('stationsExt: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('stationsExt: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /1,200 weather stations/);
});

test('stationsExt: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /Blacksburg/);
});

test('stationsExt: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
