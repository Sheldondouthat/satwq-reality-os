import assert from 'node:assert/strict';
import test from 'node:test';
import { escapeHtml, fmtCoords } from './model.js';

test('fmtCoords formats lat/lon', () => {
  assert.equal(fmtCoords(48.5583362, -123.1735774), '48.56°N 123.17°W');
  assert.equal(fmtCoords(-33.8, 151.2), '33.80°S 151.20°E');
  assert.equal(fmtCoords(NaN, 0), '—');
});

test('escapeHtml neutralizes markup', () => {
  assert.equal(escapeHtml('<audio>'), '&lt;audio&gt;');
});
