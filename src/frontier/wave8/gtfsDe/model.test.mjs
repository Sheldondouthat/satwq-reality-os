import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE, valueLine, detailLine } from './model.js';

const SAMPLE = {
  "generatedAt": "2026-09-27T19:00:00Z",
  "stale": false,
  "snapshot": {
    "fetchedAt": "2026-09-27T18:30:00Z"
  },
  "counts": {
    "tripUpdates": 12000,
    "alerts": 5,
    "deleted": 3
  },
  "topDelayed": [
    {
      "route": "S1",
      "delayMin": 14
    }
  ]
};

test('gtfsDe: ROUTE matches the registry route', () => {
  assert.equal(ROUTE, '/api/gtfs-de');
});

test('gtfsDe: valueLine is honest on unavailable envelopes', () => {
  assert.equal(valueLine(null), null);
  assert.equal(valueLine({ unavailable: true }), null);
  assert.equal(valueLine({ error: 'upstream_unavailable' }), null);
  assert.equal(detailLine(null), '');
});

test('gtfsDe: valueLine summarizes the sample payload', () => {
  const line = valueLine(SAMPLE);
  assert.ok(line, 'valueLine must not return null for the sample payload');
  assert.match(line, /GTFS-DE · 12,000 tripUpdates/);
});

test('gtfsDe: detailLine summarizes the sample payload', () => {
  assert.match(detailLine(SAMPLE), /most delayed: S1 \+14m/);
});

test('gtfsDe: snapshot-pending state is honest', () => {
  const line = valueLine({ ...SAMPLE, snapshot: undefined, stale: true }) ?? '';
  assert.match(line, /snapshot pending/);
});
