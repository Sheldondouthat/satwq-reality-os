/**
 * Live Signal Walls — unit tests (pure model).
 */
import assert from 'node:assert/strict';
import {
  TIER,
  formatMag,
  formatUsd,
  formatChangePct,
  ageStr,
  quakeRows,
  eonetCategoryLabel,
  eonetRows,
  eonetCategoryCounts,
  cryptoAssetIds,
  cryptoRows,
} from './model.js';

const tests = [];

function test(name, fn) {
  tests.push([name, fn]);
}

test('formatMag formats one decimal', () => {
  assert.equal(formatMag(5.24), 'M5.2');
  assert.equal(formatMag(null), 'M?');
});

test('formatUsd formats with commas and 2dp', () => {
  assert.equal(formatUsd(84308), '$84,308.00');
  assert.equal(formatUsd(NaN), '—');
});

test('formatChangePct signs correctly', () => {
  assert.equal(formatChangePct(1.5823), '+1.58%');
  assert.equal(formatChangePct(-0.424), '−0.42%');
  assert.equal(formatChangePct(0), '0.00%');
  assert.equal(formatChangePct(null), '—');
});

test('ageStr buckets time', () => {
  const now = 1_000_000_000_000;
  assert.equal(ageStr(now - 30_000, now), 'just now');
  assert.equal(ageStr(now - 12 * 60_000, now), '12m ago');
  assert.equal(ageStr(now - 3 * 3600_000, now), '3h ago');
  assert.equal(ageStr(now - 2 * 86400_000, now), '2d ago');
  assert.equal(ageStr(null, now), 'time unknown');
});

test('quakeRows returns null on bad payload', () => {
  assert.equal(quakeRows(null), null);
  assert.equal(quakeRows({}), null);
});

test('quakeRows sorts by magnitude desc and caps rows', () => {
  const mk = (mag, place, time) => ({ properties: { mag, place, time } });
  const rows = quakeRows(
    { features: [mk(4.6, 'a', 1), mk(6.1, 'b', 2), mk(5.0, 'c', 3)] },
    2,
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[0].mag, 6.1);
  assert.equal(rows[1].mag, 5.0);
  assert.equal(rows[0].tier, TIER.VERIFIED);
  assert.equal(rows[0].magLabel, 'M6.1');
});

test('quakeRows tolerates missing fields', () => {
  const rows = quakeRows({ features: [{ properties: {} }] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].place, 'unknown location');
  assert.equal(rows[0].magLabel, 'M?');
});

test('eonetCategoryLabel maps known ids', () => {
  assert.equal(eonetCategoryLabel('severeStorms'), 'Severe storm');
  assert.equal(eonetCategoryLabel('bogus'), 'bogus');
});

test('eonetRows returns null on bad payload, groups by category', () => {
  assert.equal(eonetRows(null), null);
  const rows = eonetRows({
    events: [
      { id: 'EONET_1', title: 'Tropical Storm Hanna', categories: [{ id: 'severeStorms' }] },
      { id: 'EONET_2', title: 'Fire X', categories: [{ id: 'wildfires' }] },
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].categoryLabel, 'Severe storm');
  assert.equal(rows[1].categoryLabel, 'Wildfire');
  assert.equal(rows[0].tier, TIER.VERIFIED);
});

test('eonetCategoryCounts counts in first-seen order', () => {
  const counts = eonetCategoryCounts([
    { category: 'wildfires', categoryLabel: 'Wildfire' },
    { category: 'severeStorms', categoryLabel: 'Severe storm' },
    { category: 'wildfires', categoryLabel: 'Wildfire' },
  ]);
  assert.deepEqual(counts, [
    { category: 'wildfires', label: 'Wildfire', count: 2 },
    { category: 'severeStorms', label: 'Severe storm', count: 1 },
  ]);
});

test('cryptoAssetIds joins the five assets', () => {
  assert.equal(cryptoAssetIds(), 'bitcoin,ethereum,ripple,solana,binancecoin');
});

test('cryptoRows normalizes prices and 24h change', () => {
  const rows = cryptoRows({
    bitcoin: { usd: 84308, usd_24h_change: 1.5823 },
    ethereum: { usd: 2687.2, usd_24h_change: -0.424 },
  });
  assert.equal(rows.length, 5);
  assert.equal(rows[0].symbol, 'BTC');
  assert.equal(rows[0].priceLabel, '$84,308.00');
  assert.equal(rows[0].changeLabel, '+1.58%');
  assert.equal(rows[0].direction, 'up');
  assert.equal(rows[1].direction, 'down');
  // assets missing from the payload are honest dashes, not zeros
  assert.equal(rows[2].priceLabel, '—');
  assert.equal(rows[2].direction, 'flat');
  assert.equal(rows[0].tier, TIER.VERIFIED);
});

test('cryptoRows returns null on bad payload', () => {
  assert.equal(cryptoRows(null), null);
});

let passed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    passed += 1;
  } catch (error) {
    console.error(`FAIL ${name}:`, error.message);
    process.exitCode = 1;
  }
}
console.log(`signalWalls model: ${passed}/${tests.length} passed`);
