import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, fmtMhz, scoreColor, solarLine } from './model.js';

test('scoreColor tiers match the legend', () => {
  assert.equal(scoreColor(85), '#4dd0a6');
  assert.equal(scoreColor(55), '#ffd166');
  assert.equal(scoreColor(25), '#ff9f43');
  assert.equal(scoreColor(5), '#ff5a5a');
  assert.equal(scoreColor(null), '#55607a');
  assert.equal(scoreColor(undefined), '#55607a');
});

test('fmtMhz formats and marks unknown', () => {
  assert.equal(fmtMhz(15.93), '15.9 MHz');
  assert.equal(fmtMhz(8), '8.0 MHz');
  assert.equal(fmtMhz(null), '—');
  assert.equal(fmtMhz(NaN), '—');
});

test('solarLine summarizes flux and Kp', () => {
  assert.equal(solarLine({ flux10cm: 101, kp: 2 }), 'F10.7 101 · Kp 2');
  assert.equal(solarLine({ flux10cm: null, kp: null }), 'F10.7 — · Kp —');
  assert.equal(solarLine(null), 'solar data unavailable');
});

test('escapeHtml neutralizes markup in station names', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml(null), '');
});
