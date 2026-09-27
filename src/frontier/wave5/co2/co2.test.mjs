import assert from 'node:assert/strict';
import test from 'node:test';
import { deltaLine, formatPpm, tickerSummary, trendGlyph } from './model.js';

test('formatPpm rounds to 2 decimals', () => {
  assert.equal(formatPpm(429.0312), '429.03 ppm');
  assert.equal(formatPpm(Number.NaN), null);
  assert.equal(formatPpm(null), null);
});

test('trendGlyph arrows by delta', () => {
  assert.equal(trendGlyph(2.72), '▲');
  assert.equal(trendGlyph(-1.2), '▼');
  assert.equal(trendGlyph(0), '▬');
  assert.equal(trendGlyph(null), '▬');
});

test('deltaLine formats signed delta with date', () => {
  assert.equal(deltaLine(2.72, '2025-09-24'), '+2.72 ppm vs 2025-09-24');
  assert.equal(deltaLine(-1.2, '2025-09-24'), '−1.2 ppm vs 2025-09-24');
  assert.equal(deltaLine(null, '2025-09-24'), null);
});

test('tickerSummary condenses a payload', () => {
  const s = tickerSummary({
    ppm: 429.03,
    date: '2026-09-24',
    delta1yPpm: 2.72,
    delta1yDate: '2025-09-24',
  });
  assert.deepEqual(s, {
    value: '429.03 ppm',
    glyph: '▲',
    delta: '+2.72 ppm vs 2025-09-24',
    date: '2026-09-24',
  });
});

test('tickerSummary returns null on a bad payload', () => {
  assert.equal(tickerSummary(null), null);
  assert.equal(tickerSummary({}), null);
});
