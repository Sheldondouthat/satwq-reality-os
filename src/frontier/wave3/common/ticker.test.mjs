import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fetchJson,
  isUnavailable,
  pickNum,
  pickArr,
  pickStr,
  itemName,
  countOf,
  honestyTags,
  withTags,
  sourceHealthLine,
  ageAgo,
  createTickerInit,
} from './ticker.js';

test('fetchJson throws coded errors on HTTP failure and bad shape', async () => {
  const bad = async () => ({ ok: false, status: 503 });
  await assert.rejects(() => fetchJson('/api/x', bad), /http_503/);
  const shapeless = async () => ({ ok: true, json: async () => null });
  await assert.rejects(() => fetchJson('/api/x', shapeless), /bad_payload/);
  const good = async () => ({ ok: true, json: async () => ({ count: 3 }) });
  assert.equal((await fetchJson('/api/x', good)).count, 3);
});

test('isUnavailable honours the honest envelope fields', () => {
  assert.ok(isUnavailable(null));
  assert.ok(isUnavailable({ unavailable: true }));
  assert.ok(isUnavailable({ error: 'x_unavailable' }));
  assert.ok(!isUnavailable({ count: 0 }));
  assert.ok(!isUnavailable({ stale: true }));
});

test('pick helpers never fabricate: null/empty when nothing is there', () => {
  assert.equal(pickNum(undefined, NaN, 4), 4);
  assert.equal(pickNum('x'), null);
  assert.deepEqual(pickArr(null, [], [1]), [1]);
  assert.equal(pickStr('', '  ', 'ok'), 'ok');
  assert.equal(itemName({}), '');
  assert.equal(itemName({ callsign: 'K1JT' }), 'K1JT');
  assert.equal(countOf({}), null);
  assert.equal(countOf({ stationCount: 12 }), 12);
});

test('honestyTags labels stale/partial/model payloads', () => {
  assert.deepEqual(honestyTags({}), []);
  assert.deepEqual(honestyTags({ stale: true, partial: true }), ['stale', 'partial']);
  assert.match(withTags('x', { model: true }), /model: simulation/);
  assert.equal(withTags('x', {}), 'x');
});

test('sourceHealthLine counts ok!==false and error-free sources as live', () => {
  const doc = {
    sources: { a: { ok: true }, b: { ok: false }, c: { error: 'boom' }, d: {} },
    systems: { s1: { ok: true } },
  };
  assert.equal(sourceHealthLine(doc), '2/4 sources live · 1/1 systems live');
  assert.equal(sourceHealthLine({}), '');
});

test('ageAgo degrades to n/a on bad input', () => {
  assert.equal(ageAgo('not-a-date'), 'n/a');
  assert.match(ageAgo(new Date(Date.now() - 90 * 60_000).toISOString()), /1h ago/);
});

test('createTickerInit returns null without a DOM', () => {
  const init = createTickerInit({
    themeKey: 'feature.x',
    fallbackLabel: 'X',
    emoji: '❌',
    route: '/api/x',
    valueLine: () => 'x',
  });
  assert.equal(init({}), null);
});
