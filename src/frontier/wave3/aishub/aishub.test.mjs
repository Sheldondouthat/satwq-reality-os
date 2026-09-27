/**
 * Wave 3 Track 2c / 2.17 — AISHub tests.
 * Fixtures are real rows from aishub.net/stations/export-json (2026-09-27).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeAishubStation,
  parseAishubStations,
} from '../../../../server/providers/wave3/aishub.js';
import { freshnessBucket, freshnessColorCss, pickStations } from './model.js';
import { createAishubSource } from './source.js';

const REAL_ROWS = [
  { id: '2011', country: 'se', location: 'Gothenburg', latitude: '57.71', longitude: '11.97', unix_time: '1790488502' },
  { id: '2008', country: 'ua', location: 'Roaming station', latitude: '0.00', longitude: '0.00', unix_time: '1790488502' },
  { id: 'x', country: 'zz', location: '', latitude: 'abc', longitude: '11.97', unix_time: '1' },
];

test('normalizeAishubStation keeps real stations, drops zeroed placeholders', () => {
  const s = normalizeAishubStation(REAL_ROWS[0]);
  assert.equal(s.id, '2011');
  assert.equal(s.country, 'se');
  assert.equal(s.location, 'Gothenburg');
  assert.equal(s.lat, 57.71);
  assert.equal(s.lon, 11.97);
  assert.equal(s.lastSeen, 1790488502);
  assert.equal(normalizeAishubStation(REAL_ROWS[1]), null); // 0,0 placeholder
  assert.equal(normalizeAishubStation(REAL_ROWS[2]), null); // bad lat
});

test('parseAishubStations reports placed vs zeroed counts', () => {
  const { stations, zeroed, reported } = parseAishubStations(JSON.stringify(REAL_ROWS));
  assert.equal(reported, 3);
  assert.equal(stations.length, 1);
  assert.equal(zeroed, 2);
  assert.throws(() => parseAishubStations('{}'), /aishub_not_array/);
});

test('freshnessBucket grades station recency', () => {
  const now = 1790488502;
  assert.equal(freshnessBucket(now, now), 'live');
  assert.equal(freshnessBucket(now - 1800, now), 'live');
  assert.equal(freshnessBucket(now - 7200, now), 'day');
  assert.equal(freshnessBucket(now - 90000, now), 'stale');
  assert.equal(freshnessBucket(null, now), 'unknown');
  assert.equal(freshnessBucket(now + 100, now), 'unknown');
  assert.equal(freshnessColorCss('live'), '#4dd0a6');
});

test('pickStations sorts live-first and caps', () => {
  const now = 1790488502;
  const stations = [
    { id: 'a', lastSeen: now - 90000 },
    { id: 'b', lastSeen: now - 10 },
    { id: 'c', lastSeen: now - 7200 },
  ];
  const picked = pickStations(stations, now, 2);
  assert.deepEqual(picked.map((s) => s.id), ['b', 'c']);
});

test('createAishubSource validates the /api/aishub shape', async () => {
  const ok = createAishubSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({ stations: [] }) }),
  });
  assert.deepEqual((await ok.getSnapshot()).stations, []);
  const bad = createAishubSource({
    fetchImpl: async () => ({ ok: true, json: async () => ({}) }),
  });
  await assert.rejects(() => bad.getSnapshot(), /aishub_bad_shape/);
});
