import assert from 'node:assert/strict';
import test from 'node:test';
import { formatIntensity, indexColor, tickerSummary } from './model.js';

test('indexColor maps the ESO bands', () => {
  assert.equal(indexColor('low'), '#a8d95e');
  assert.equal(indexColor('moderate'), '#f5c542');
  assert.equal(indexColor('high'), '#ff8a3d');
  assert.equal(indexColor('very high'), '#ff5a5a');
  assert.equal(indexColor('very low'), '#59d98c');
  assert.equal(indexColor('mystery'), '#8a93a6');
});

test('formatIntensity rounds and units', () => {
  assert.equal(formatIntensity(97), '97 gCO₂/kWh');
  assert.equal(formatIntensity(97.4), '97 gCO₂/kWh');
  assert.equal(formatIntensity(null), null);
});

test('tickerSummary condenses a payload', () => {
  const s = tickerSummary({
    value: 97,
    index: 'moderate',
    valueIsForecast: false,
    from: '2026-09-27T19:00Z',
    to: '2026-09-27T19:30Z',
  });
  assert.equal(s.value, '97 gCO₂/kWh');
  assert.equal(s.index, 'moderate');
  assert.equal(s.color, '#f5c542');
  assert.equal(s.isForecast, false);
  assert.equal(s.window, '2026-09-27T19:00Z → 2026-09-27T19:30Z');
});

test('tickerSummary flags forecast values', () => {
  const s = tickerSummary({ value: 120, index: 'high', valueIsForecast: true });
  assert.equal(s.isForecast, true);
});

test('tickerSummary returns null on a bad payload', () => {
  assert.equal(tickerSummary(null), null);
  assert.equal(tickerSummary({ value: 'lots' }), null);
});
