import assert from 'node:assert/strict';
import test from 'node:test';
import { formatRate, formatUsd, legStatus, tickerSummary } from './model.js';

test('formatUsd formats with commas', () => {
  assert.equal(formatUsd(84752.39), '$84,752.39');
  assert.equal(formatUsd(null), '—');
});

test('formatRate trims to 4 decimals', () => {
  assert.equal(formatRate(0.87696), '0.877');
  assert.equal(formatRate(null), '—');
});

test('legStatus splits live from degraded legs', () => {
  const { live, degraded } = legStatus(
    { coingecko: 84718, binanceUs: 84752.39, coinbase: null },
    { coingecko: false, binanceUs: false, coinbase: true },
  );
  assert.equal(live.length, 2);
  assert.deepEqual(degraded, ['coinbase']);
});

test('tickerSummary condenses a payload', () => {
  const s = tickerSummary({
    value: 84752.39,
    fx: { date: '2026-09-25', rates: { EUR: 0.87696, GBP: 0.74, JPY: 147.5 }, degraded: false },
    crypto: {
      btc: { coingecko: 84718, binanceUs: 84752.39, coinbase: 84763.345, medianUsd: 84752.39 },
      degraded: { coingecko: false, binanceUs: false, coinbase: false },
    },
  });
  assert.equal(s.btcMedian, '$84,752.39');
  assert.equal(s.fxEur, '€1 = 1.1403');
  assert.equal(s.liveLegs.length, 3);
  assert.equal(s.anyDegraded, false);
});

test('tickerSummary marks degraded legs honestly', () => {
  const s = tickerSummary({
    value: 84750,
    fx: { date: null, rates: {}, degraded: true },
    crypto: {
      btc: { coingecko: null, binanceUs: 84750, coinbase: 84750, medianUsd: 84750 },
      degraded: { coingecko: true, binanceUs: false, coinbase: false },
    },
  });
  assert.deepEqual(s.degradedLegs, ['CoinGecko']);
  assert.equal(s.fxEur, null);
  assert.equal(s.anyDegraded, true);
});

test('tickerSummary returns null on a bad payload', () => {
  assert.equal(tickerSummary(null), null);
});
