import assert from 'node:assert/strict';
import test from 'node:test';
import { feltLabel, formatAge, magColor, testimonySize, topFelt } from './model.js';

const NOW = Date.parse('2026-09-27T18:00:00Z');

test('testimonySize scales with sqrt and stays in [6,26]', () => {
  assert.equal(testimonySize(0), 6);
  assert.equal(testimonySize(NaN), 6);
  assert.ok(testimonySize(42) > 6);
  assert.equal(testimonySize(10_000_000), 26); // clamped
});

test('magColor grades by magnitude, gray when unknown', () => {
  assert.equal(magColor(2.5), '#9fb3d6');
  assert.equal(magColor(4.0), '#ffb454');
  assert.equal(magColor(5.0), '#ff7a3d');
  assert.equal(magColor(6.5), '#ff5a5a');
  assert.equal(magColor(null), '#8a93a6');
});

test('formatAge renders relative time', () => {
  assert.equal(formatAge(NOW - 30_000, NOW), 'just now');
  assert.equal(formatAge(NOW - 90 * 60_000, NOW), '1h ago');
  assert.equal(formatAge(NOW - 3 * 86400_000, NOW), '3d ago');
  assert.equal(formatAge(null, NOW), 'time unknown');
});

test('feltLabel carries magnitude, testimonies and age', () => {
  const label = feltLabel(
    { mag: 3.5, testimonyCount: 42, timeMs: NOW - 2 * 3600_000 },
    NOW,
  );
  assert.match(label, /M3\.5/);
  assert.match(label, /42 testimonies/);
  assert.match(label, /2h ago/);
});

test('topFelt sorts by testimonyCount and takes n', () => {
  const events = [
    { id: 'a', testimonyCount: 3 },
    { id: 'b', testimonyCount: 30 },
    { id: 'c', testimonyCount: 10 },
  ];
  assert.deepEqual(topFelt(events, 2).map((e) => e.id), ['b', 'c']);
});
