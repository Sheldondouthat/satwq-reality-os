import assert from 'node:assert/strict';
import test from 'node:test';
import { modeColor, bandLabel, spotAge, spotLabel, plottableSpots, escapeHtml } from './model.js';

test('modeColor tiers match the legend', () => {
  assert.equal(modeColor('CW'), '#ffb454');
  assert.equal(modeColor('SSB'), '#4dd0a6');
  assert.equal(modeColor('LSB'), '#4dd0a6');
  assert.equal(modeColor('FT8'), '#6aa8ff');
  assert.equal(modeColor('FM'), '#6aa8ff');
  assert.equal(modeColor('weird'), '#8a93a6');
  assert.equal(modeColor(null), '#8a93a6');
});

test('bandLabel maps kHz to ham bands', () => {
  assert.equal(bandLabel(7074.0), '40m');
  assert.equal(bandLabel(21043.0), '15m');
  assert.equal(bandLabel(145.5 * 1000), '2m');
  assert.equal(bandLabel(5000), 'HF');
  assert.equal(bandLabel(null), '—');
  assert.equal(bandLabel(-1), '—');
});

test('spotAge formats relative times', () => {
  const now = Date.parse('2026-09-27T20:00:00Z');
  assert.equal(spotAge('2026-09-27T19:59:30Z', now), 'just now');
  assert.equal(spotAge('2026-09-27T19:57:00Z', now), '3m ago');
  assert.equal(spotAge('2026-09-27T18:30:00Z', now), '1h 30m ago');
  assert.equal(spotAge('2026-09-25T20:00:00Z', now), '2d ago');
  assert.equal(spotAge('garbage', now), '—');
});

test('spotLabel composes callsign, band, mode', () => {
  assert.equal(spotLabel({ activator: 'K2EAG/VE3', frequencyKhz: 21043.0, mode: 'CW' }), 'K2EAG/VE3 · 15m · CW');
  assert.equal(spotLabel({ activator: 'XX', frequencyKhz: null, mode: '' }), 'XX');
});

test('plottableSpots keeps only geo rows and caps', () => {
  const rows = [
    { lat: 44.6, lon: 11.1 },
    { lat: null, lon: 1 },
    { lat: 1, lon: null },
    {},
  ];
  assert.equal(plottableSpots(rows).length, 1);
  assert.equal(plottableSpots(rows, 0).length, 0);
  assert.deepEqual(plottableSpots(null), []);
});

test('escapeHtml neutralizes markup in callsigns', () => {
  assert.equal(escapeHtml('<b>W1AW</b>'), '&lt;b&gt;W1AW&lt;/b&gt;');
  assert.equal(escapeHtml(null), '');
});
