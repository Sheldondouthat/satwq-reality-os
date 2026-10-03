/**
 * Wave 9 — mempool.space provider tests (real 2026-10-03 live bytes, no mocks of shape).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  parseHeightText,
  parseTipBlock,
  parseFees,
  parseMempool,
  buildPayload,
  numOrNull,
  mempoolProxy,
  _mempoolInternals,
} from './mempool.js';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

const heightText = readFileSync(join(FIX, 'mempool-2026-10-03-height.txt'), 'utf8');
const blocksJson = JSON.parse(readFileSync(join(FIX, 'mempool-2026-10-03-blocks.json'), 'utf8'));
const feesJson = JSON.parse(readFileSync(join(FIX, 'mempool-2026-10-03-fees.json'), 'utf8'));
const mempoolJson = JSON.parse(readFileSync(join(FIX, 'mempool-2026-10-03-mempool.json'), 'utf8'));

test('height fixture parses to the live chain tip', () => {
  assert.equal(parseHeightText(heightText), 969740);
});

test('height parser guards the Number("")===0 trap and junk', () => {
  assert.equal(parseHeightText(''), null);
  assert.equal(parseHeightText('   \n'), null);
  assert.equal(parseHeightText('not-a-number'), null);
  assert.equal(parseHeightText(null), null);
  assert.equal(parseHeightText('969740.9'), 969740);
});

test('tip block fixture parses the real tip fields', () => {
  const tip = parseTipBlock(blocksJson);
  assert.equal(tip.height, 969740);
  assert.equal(tip.txCount, 4071);
  assert.equal(tip.sizeBytes, 1578130);
  assert.equal(tip.timestamp, 1791040909);
  assert.match(tip.hash, /^[0-9a-f]{64}$/);
  assert.ok(tip.difficulty > 0);
});

test('tip parser rejects non-arrays and empties honestly', () => {
  assert.equal(parseTipBlock(null), null);
  assert.equal(parseTipBlock([]), null);
  assert.equal(parseTipBlock({ not: 'array' }), null);
  assert.equal(parseTipBlock([null]), null);
});

test('fees fixture parses the live sat/vB recommendations', () => {
  const f = parseFees(feesJson);
  assert.deepEqual(f, { fastest: 6, halfHour: 5, hour: 4, economy: 2, minimum: 1 });
});

test('fees parser guards empties (never zero-filled)', () => {
  const f = parseFees({ fastestFee: '', halfHourFee: null, hourFee: 'abc', economyFee: 2, minimumFee: 1 });
  assert.equal(f.fastest, null);
  assert.equal(f.halfHour, null);
  assert.equal(f.hour, null);
  assert.equal(f.economy, 2);
  assert.equal(parseFees(null), null);
});

test('mempool fixture parses live congestion counts', () => {
  const m = parseMempool(mempoolJson);
  assert.equal(m.txCount, 84809);
  assert.equal(m.vsizeBytes, 44631960);
  assert.ok(m.totalFeeSats > 0);
});

test('mempool parser guards empties', () => {
  const m = parseMempool({ count: '', vsize: null, total_fee: '19' });
  assert.equal(m.txCount, null);
  assert.equal(m.vsizeBytes, null);
  assert.equal(m.totalFeeSats, 19);
  assert.equal(parseMempool(null), null);
});

test('numOrNull guards the Number("")===0 trap', () => {
  assert.equal(numOrNull(''), null);
  assert.equal(numOrNull(null), null);
  assert.equal(numOrNull('0'), 0); // a REAL zero is kept, not nulled
  assert.equal(numOrNull('1,234'), 1234);
});

test('buildPayload carries the honesty block and stale flag', () => {
  const p = buildPayload(
    {
      height: 969740,
      tip: { height: 969740 },
      fees: { fastest: 6 },
      mempool: { txCount: 84809 },
    },
    false,
  );
  assert.equal(p.height, 969740);
  assert.equal(p.stale, false);
  assert.ok(p.generatedAt);
  assert.equal(p.upstream.length, 4);
  assert.match(p.honesty.feesAreProjections, /never a confirmation guarantee/);
  assert.match(p.honesty.attribution, /mempool\.space/);
  const s = buildPayload({ height: null, tip: null, fees: null, mempool: null }, true);
  assert.equal(s.stale, true);
});

test('handler rejects non-GET with 405', async () => {
  const { handler } = (() => {
    // reach the handler via a fake middleware mount
    let h = null;
    const proxy = mempoolProxy();
    proxy.configureServer({ middlewares: { use: (route, fn) => { if (route === '/api/mempool') h = fn; } } });
    return { handler: h };
  })();
  assert.ok(handler, 'handler mounted');
  let status = null;
  let body = null;
  const res = {
    writeHead: (s) => { status = s; },
    end: (b) => { body = b; },
  };
  await handler({ method: 'POST' }, res);
  assert.equal(status, 405);
  assert.match(body, /method_not_allowed/);
});

test('internals expose the endpoints and reset hook', () => {
  assert.equal(_mempoolInternals.ENDPOINTS.height, 'https://mempool.space/api/blocks/tip/height');
  assert.equal(typeof _mempoolInternals.resetCache, 'function');
});
