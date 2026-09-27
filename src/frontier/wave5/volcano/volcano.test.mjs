import assert from 'node:assert/strict';
import test from 'node:test';
import { levelColor, noElevated, rankActive, tickerLabel, tickerStatus } from './model.js';

test('levelColor maps alert colors, gray fallback', () => {
  assert.equal(levelColor('GREEN'), '#3ddc84');
  assert.equal(levelColor('yellow'), '#ffd23d');
  assert.equal(levelColor('ORANGE'), '#ff8a3d');
  assert.equal(levelColor('Red'), '#ff4d4d');
  assert.equal(levelColor(null), '#8a93a6');
});

test('rankActive sorts RED > ORANGE > YELLOW > GREEN by name within tier', () => {
  const entries = [
    { name: 'b-green', color: 'GREEN' },
    { name: 'a-red', color: 'RED' },
    { name: 'c-yellow', color: 'YELLOW' },
    { name: 'd-orange', color: 'ORANGE' },
  ];
  assert.deepEqual(rankActive(entries).map((e) => e.name), ['a-red', 'd-orange', 'c-yellow', 'b-green']);
});

test('tickerLabel carries name, color and region', () => {
  const label = tickerLabel({ name: 'White Island', color: 'Yellow', region: 'New Zealand' });
  assert.match(label, /White Island/);
  assert.match(label, /YELLOW/);
  assert.match(label, /New Zealand/);
});

test('noElevated is true on empty, false otherwise', () => {
  assert.equal(noElevated([]), true);
  assert.equal(noElevated([{ name: 'x', color: 'RED' }]), false);
});

test('tickerStatus reports count and source issues', () => {
  assert.match(tickerStatus(2, []), /2 elevated-alert volcanoes/);
  assert.match(tickerStatus(0, []), /no elevated-alert volcanoes/);
  assert.match(tickerStatus(1, ['avo_unavailable: x']), /1 elevated-alert volcano/);
  assert.match(tickerStatus(1, ['avo_unavailable: x']), /1 source issue/);
});
