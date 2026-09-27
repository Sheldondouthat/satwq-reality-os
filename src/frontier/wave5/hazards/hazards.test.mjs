import assert from 'node:assert/strict';
import test from 'node:test';
import { hazardColor, hazardGlyph, hazardLabel, hazardTypeName, rankHazards } from './model.js';

test('hazardColor maps each type, gray fallback', () => {
  assert.equal(hazardColor('EQ'), '#ff5a5a');
  assert.equal(hazardColor('TC'), '#c44dff');
  assert.equal(hazardColor('FL'), '#4da3ff');
  assert.equal(hazardColor('WF'), '#ffb454');
  assert.equal(hazardColor('VO'), '#ff3d71');
  assert.equal(hazardColor('DR'), '#b07a4f');
  assert.equal(hazardColor('OTHER'), '#8a93a6');
});

test('hazardGlyph is a single glyph per type', () => {
  assert.equal(hazardGlyph('TC'), '🌀');
  assert.equal(hazardGlyph('BOGUS'), '⚠️');
});

test('rankHazards puts live Red first, Orange after', () => {
  const events = [
    { name: 'o', alertlevel: 'Orange', iscurrent: false },
    { name: 'r-dead', alertlevel: 'Red', iscurrent: false },
    { name: 'r-live', alertlevel: 'Red', iscurrent: true },
  ];
  assert.deepEqual(rankHazards(events).map((e) => e.name), ['r-live', 'r-dead', 'o']);
});

test('hazardLabel badges live events', () => {
  const label = hazardLabel({ name: 'Cyclone X', alertlevel: 'Red', iscurrent: true, country: 'Mexico' });
  assert.match(label, /● LIVE/);
  assert.match(label, /Red/);
  assert.match(label, /Mexico/);
});

test('hazardTypeName covers all GDACS types', () => {
  for (const t of ['EQ', 'TC', 'FL', 'WF', 'VO', 'DR']) {
    assert.notEqual(hazardTypeName(t), 'other');
  }
});
