import assert from 'node:assert/strict';
import test from 'node:test';
import { formatUv, shortTime, tickerSummary, uvBand } from './model.js';

test('uvBand follows the WHO bands', () => {
  assert.deepEqual(uvBand(1.5).label, 'Low');
  assert.deepEqual(uvBand(4.15).label, 'Moderate');
  assert.deepEqual(uvBand(6.5).label, 'High');
  assert.deepEqual(uvBand(9).label, 'Very high');
  assert.deepEqual(uvBand(11.5).label, 'Extreme');
  assert.deepEqual(uvBand(Number.NaN).label, 'unknown');
});

test('formatUv rounds to one decimal', () => {
  assert.equal(formatUv(4.15), '4.2');
  assert.equal(formatUv(null), null);
});

test('shortTime trims an ISO timestamp', () => {
  assert.equal(shortTime('2026-09-27T19:12'), '19:12');
  assert.equal(shortTime(null), null);
});

test('tickerSummary condenses a payload', () => {
  const s = tickerSummary({
    uvIndex: 4.15,
    current: { isDay: true, temperatureC: 20.1 },
    today: {
      uvIndexMax: 6.8,
      sunrise: '2026-09-27T07:15',
      sunset: '2026-09-27T19:12',
    },
  });
  assert.equal(s.value, 'UV 4.2');
  assert.equal(s.band, 'Moderate');
  assert.equal(s.isDay, true);
  assert.equal(s.todayMax, 'max 6.8');
  assert.equal(s.sun, '↑07:15 ↓19:12');
});

test('tickerSummary returns null on a bad payload', () => {
  assert.equal(tickerSummary(null), null);
  assert.equal(tickerSummary({ uvIndex: Number.NaN }), null);
});
