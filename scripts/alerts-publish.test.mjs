/**
 * alerts-publish.mjs tests — pure parts only (no network).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ntfyPriority,
  ntfyTags,
  asciiFold,
  formatNtfyMessage,
  newFirings,
} from './alerts-publish.mjs';

test('ntfyPriority maps severities to ntfy levels', () => {
  assert.equal(ntfyPriority('critical'), 'urgent');
  assert.equal(ntfyPriority('high'), 'high');
  assert.equal(ntfyPriority('medium'), 'default');
  assert.equal(ntfyPriority('bogus'), 'default');
});

test('ntfyTags maps rule ids to emoji tags', () => {
  assert.equal(ntfyTags('quake-m6'), 'earthquake');
  assert.equal(ntfyTags('nws-severe'), 'rotating_light');
  assert.equal(ntfyTags('faa-ground'), 'airplane');
  assert.equal(ntfyTags('mirova-thermal'), 'volcano');
  assert.equal(ntfyTags('swpc-g4'), 'zap');
  assert.equal(ntfyTags('unknown-rule'), 'bell');
});

test('asciiFold strips non-latin1 for header safety', () => {
  assert.equal(asciiFold('M6.2 — Tambolaka'), 'M6.2 ? Tambolaka');
  assert.ok(/^[\x20-\x7E]*$/.test(asciiFold('Grímsvötn 🌋 test')));
});

test('formatNtfyMessage builds the body', () => {
  const msg = formatNtfyMessage({
    severity: 'high',
    title: 'M6.2 earthquake — Tambolaka',
    detail: 'Magnitude 6.2 at 2026-10-04T15:50:00.000Z. Source: USGS.',
    link: 'https://earthquake.usgs.gov/earthquakes/eventpage/x',
    observedAt: '2026-10-04T15:50:00.000Z',
  });
  assert.ok(msg.startsWith('[HIGH] M6.2 earthquake'), msg);
  assert.ok(msg.includes('Source: USGS.'), msg);
  assert.ok(msg.includes('https://earthquake.usgs.gov/'), msg);
});

test('newFirings returns only unseen dedupeKeys', () => {
  const firings = [
    { dedupeKey: 'quake:a', title: 'A' },
    { dedupeKey: 'quake:b', title: 'B' },
    { dedupeKey: null, title: 'no-key' },
  ];
  const fresh = newFirings(firings, { 'quake:a': '2026-10-04T00:00:00Z' });
  assert.deepEqual(
    fresh.map((f) => f.dedupeKey),
    ['quake:b'],
  );
});

test('newFirings tolerates a missing firings array', () => {
  assert.deepEqual(newFirings(null, {}), []);
  assert.deepEqual(newFirings(undefined, {}), []);
});
