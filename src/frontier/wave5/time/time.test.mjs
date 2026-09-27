import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchTime, formatTaiUtc, leapLine, tickerLine } from './model.js';

test('formatTaiUtc formats the offset or admits unknown', () => {
  assert.equal(formatTaiUtc(37), 'TAI−UTC = 37 s');
  assert.equal(formatTaiUtc(null), 'TAI−UTC: unknown');
  assert.equal(formatTaiUtc(NaN), 'TAI−UTC: unknown');
});

test('leapLine treats null as the normal no-leap state', () => {
  assert.equal(leapLine(null), 'no leap second announced');
  assert.equal(
    leapLine({ date: '2027-01-01', taiMinusUtc: 38, announcedBy: 'iers-bulletin-c' }),
    'next leap: 2027-01-01 (iers-bulletin-c) → TAI−UTC 38 s',
  );
  assert.equal(leapLine({ date: '1 Jan 2033' }), 'next leap: 1 Jan 2033');
});

test('tickerLine composes the dock line with disagreement and stale flags', () => {
  const base = { taiMinusUtc: 37, nextLeap: null, agreement: 'agree', stale: false, unavailable: false };
  assert.equal(tickerLine(base), '🕰 TAI−UTC = 37 s · no leap second announced');
  assert.match(tickerLine({ ...base, agreement: 'disagree' }), /disagree — IERS shown/);
  assert.match(tickerLine({ ...base, stale: true }), /\(stale\)/);
  assert.equal(tickerLine({ unavailable: true }), '🕰 time standards unavailable');
  assert.equal(tickerLine(null), '🕰 time standards unavailable');
});

test('fetchTime validates shape and surfaces HTTP errors', async () => {
  const good = async () => ({ ok: true, json: async () => ({ taiMinusUtc: 37 }) });
  assert.equal((await fetchTime(good)).taiMinusUtc, 37);

  const bad = async () => ({ ok: true, json: async () => null });
  await assert.rejects(() => fetchTime(bad), /time_unexpected_shape/);

  const fail = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchTime(fail), /time_http_503/);
});
