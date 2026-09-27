import assert from 'node:assert/strict';
import test from 'node:test';
import { marketsProxy, _marketsInternals } from './markets.js';

const { extractFx, extractCoingecko, extractBinance, extractCoinbase, median, buildMarketsSnapshot, clearCaches } = _marketsInternals;

function fakeRes() {
  const chunks = [];
  const res = {
    statusCode: null,
    headers: {},
    writeHead(status, headers) { res.statusCode = status; res.headers = headers; },
    end(body) { chunks.push(body); res.body = chunks.join(''); },
  };
  return res;
}

function fakeReq(method = 'GET') {
  return { method, url: '/api/markets', originalUrl: '/api/markets', on: () => {}, removeListener: () => {}, headers: {} };
}

function mount(provider) {
  const calls = [];
  provider.configureServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  provider.configurePreviewServer({ middlewares: { use: (route, handler) => calls.push({ route, handler }) } });
  return calls;
}

test('marketsProxy mounts /api/markets on both server shapes', () => {
  const routes = mount(marketsProxy()).map((c) => c.route);
  assert.deepEqual(routes, ['/api/markets', '/api/markets']);
});

test('extractors handle the verified upstream shapes', () => {
  const fx = extractFx({ amount: 1.0, base: 'USD', date: '2026-09-25', rates: { EUR: 0.87696, GBP: 0.74212, JPY: 147.55 } });
  assert.deepEqual(fx.rates, { EUR: 0.87696, GBP: 0.74212, JPY: 147.55 });
  assert.equal(extractCoingecko({ bitcoin: { usd: 84718 } }), 84718);
  assert.equal(extractBinance({ symbol: 'BTCUSD', price: '84752.39000000' }), 84752.39);
  assert.equal(extractCoinbase({ data: { amount: '84763.345', base: 'BTC', currency: 'USD' } }), 84763.345);
  assert.equal(extractFx({ rates: { EUR: 0.8 } }), null); // missing leg -> null
  assert.equal(extractCoingecko({}), null);
});

test('median of mixed leg values', () => {
  assert.equal(median([84718, 84752.39, 84763.345]), 84752.39);
  assert.equal(median([1, 3]), 2);
  assert.equal(median([]), null);
});

test('buildMarketsSnapshot degrades a single failed leg (CoinGecko 429)', async () => {
  const snap = await buildMarketsSnapshot(async (label) => {
    if (label === 'markets_coingecko')
      return { ok: false, value: null, detail: 'markets_coingecko_upstream_429' };
    const value =
      label === 'markets_fx'
        ? { base: 'USD', date: '2026-09-25', rates: { EUR: 0.88, GBP: 0.74, JPY: 147.5 } }
        : 84750;
    return { ok: true, value, detail: null };
  });
  assert.equal(snap.crypto.degraded.coingecko, true);
  assert.equal(snap.crypto.btc.coingecko, null);
  assert.equal(snap.crypto.btc.binanceUs, 84750);
  assert.equal(snap.degradedDetail.coingecko, 'markets_coingecko_upstream_429');
  assert.equal(snap.fx.degraded, false);
  assert.equal(snap.value, 84750); // median of the two surviving BTC legs
});

test('buildMarketsSnapshot throws 502 when every leg fails', async () => {
  const fail = async () => ({ ok: false, value: null, detail: 'down' });
  await assert.rejects(() => buildMarketsSnapshot(fail), /markets_all_sources_failed/);
});

test('handler serves snapshot with mocked fetch', async () => {
  const calls = mount(marketsProxy());
  const realFetch = globalThis.fetch;
  const bodies = {
    'api.frankfurter.app': JSON.stringify({ base: 'USD', date: '2026-09-25', rates: { EUR: 0.87696, GBP: 0.74212, JPY: 147.55 } }),
    'api.coingecko.com': JSON.stringify({ bitcoin: { usd: 84718 } }),
    'api.binance.us': JSON.stringify({ symbol: 'BTCUSD', price: '84752.39000000' }),
    'api.coinbase.com': JSON.stringify({ data: { amount: '84763.345', base: 'BTC', currency: 'USD' } }),
  };
  globalThis.fetch = async (url) => {
    const host = Object.keys(bodies).find((h) => String(url).includes(h));
    if (!host) return new Response('x', { status: 404 });
    return new Response(bodies[host], { status: 200 });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq(), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.deepEqual(payload.fx.rates, { EUR: 0.87696, GBP: 0.74212, JPY: 147.55 });
    assert.equal(payload.crypto.btc.coingecko, 84718);
    assert.equal(payload.value, 84752.39); // median of 3 legs
    assert.equal(payload.crypto.degraded.coingecko, false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler serves 200 with CoinGecko 429 degraded leg', async () => {
  clearCaches();
  const calls = mount(marketsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes('api.coingecko.com')) return new Response('rate limited', { status: 429 });
    if (String(url).includes('api.frankfurter.app'))
      return new Response(JSON.stringify({ base: 'USD', date: '2026-09-25', rates: { EUR: 0.88, GBP: 0.74, JPY: 147.5 } }), { status: 200 });
    return new Response(JSON.stringify({ symbol: 'BTCUSD', price: '84700.00' }), { status: 200 });
  };
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq(), res);
    assert.equal(res.statusCode, 200);
    const payload = JSON.parse(res.body);
    assert.equal(payload.crypto.degraded.coingecko, true);
    assert.equal(payload.crypto.btc.coingecko, null);
    assert.equal(payload.fx.degraded, false);
    assert.match(payload.degradedDetail.coingecko, /429/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler returns 502 JSON when every leg is down', async () => {
  clearCaches();
  const calls = mount(marketsProxy());
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('down', { status: 503 });
  try {
    const res = fakeRes();
    await calls[0].handler(fakeReq(), res);
    assert.equal(res.statusCode, 502);
    assert.match(res.body, /markets_unavailable/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('handler rejects non-GET with 405', async () => {
  const calls = mount(marketsProxy());
  const res = fakeRes();
  await calls[0].handler(fakeReq('POST'), res);
  assert.equal(res.statusCode, 405);
});
