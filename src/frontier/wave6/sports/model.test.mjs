import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "games": [
    {
      "league": "nfl",
      "home": "KC",
      "away": "BUF",
      "homeScore": 24,
      "awayScore": 21,
      "state": "Q3"
    }
  ]
};

test('sports: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/sports');
});

test('sports: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('sports: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /1 games/);
});

test('sports: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /BUF 21 @ KC 24/);
});

test('sports: stale payloads are labeled, never hidden', () => {
  const line = valueLine({ ...SAMPLE, stale: true }) ?? '';
  assert.match(line, /stale/);
});
