/**
 * Market ticker proxy (keyless): Frankfurter FX + BTC across three spot legs.
 *
 * Upstreams (all verified live 2026-09-27):
 *   FX:  https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY  (ECB daily)
 *   CG:  https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd
 *   BIN: https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD
 *   CB:  https://api.coinbase.com/v2/prices/BTC-USD/spot
 *
 * CoinGecko is rate-limit prone: any failure (including 429) is a HARD STOP
 * for that leg only — it degrades in place, never retries, and never blocks
 * the other legs. The whole snapshot degrades only when EVERY leg fails.
 *
 * Routes:
 *   GET /api/markets → {generatedAt, unit, fx:{...}, crypto:{...}}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'error' pinned hosts, no node: imports, no WASM).
 */

import { fetchJsonCapped, makeCache, numOrNull, sendJson, buildProxy } from './_lib.js';

const FX_URL = 'https://api.frankfurter.app/latest?from=USD&to=EUR,GBP,JPY';
const COINGECKO_URL = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd';
const BINANCE_URL = 'https://api.binance.us/api/v3/ticker/price?symbol=BTCUSD';
const COINBASE_URL = 'https://api.coinbase.com/v2/prices/BTC-USD/spot';
const UPSTREAM_TIMEOUT_MS = 15_000;
const BODY_CAP_BYTES = 64 * 1024;
const CACHE_TTL_MS = 5 * 60_000; // gentle for CoinGecko: ≤12 calls/hour
const ATTRIBUTION =
  'Frankfurter (open, ECB reference rates) · CoinGecko (free tier) · ' +
  'Binance US + Coinbase public market data';

const LEG_SOURCES = {
  fx: 'Frankfurter (ECB daily reference rates)',
  coingecko: 'CoinGecko free tier',
  binanceUs: 'Binance US public market data',
  coinbase: 'Coinbase public spot price',
};

async function leg(label, url, extract) {
  try {
    const upstream = await fetchJsonCapped({
      url,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      bodyCapBytes: BODY_CAP_BYTES,
      label,
    });
    const value = extract(upstream);
    if (value === null)
      return { ok: false, value: null, detail: `${label}_unexpected_shape` };
    return { ok: true, value, detail: null };
  } catch (error) {
    // Hard stop on any failure — CoinGecko 429 included: no retry, this leg only.
    return { ok: false, value: null, detail: error?.message ?? 'unknown' };
  }
}

function extractFx(upstream) {
  const rates = upstream?.rates;
  if (!rates || typeof rates !== 'object') return null;
  const out = {};
  for (const ccy of ['EUR', 'GBP', 'JPY']) {
    const v = numOrNull(rates[ccy]);
    if (v === null) return null;
    out[ccy] = v;
  }
  return { base: upstream.base ?? 'USD', date: upstream.date ?? null, rates: out };
}

function extractCoingecko(upstream) {
  return numOrNull(upstream?.bitcoin?.usd);
}

function extractBinance(upstream) {
  return numOrNull(upstream?.price);
}

function extractCoinbase(upstream) {
  return numOrNull(upstream?.data?.amount);
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.round(m * 100) / 100;
}

export async function buildMarketsSnapshot(fetchLeg = leg) {
  const [fxR, cgR, binR, cbR] = await Promise.all([
    fetchLeg('markets_fx', FX_URL, extractFx),
    fetchLeg('markets_coingecko', COINGECKO_URL, extractCoingecko),
    fetchLeg('markets_binance_us', BINANCE_URL, extractBinance),
    fetchLeg('markets_coinbase', COINBASE_URL, extractCoinbase),
  ]);
  const btcPrices = [];
  const btc = {
    coingecko: cgR.value,
    binanceUs: binR.value,
    coinbase: cbR.value,
  };
  for (const v of Object.values(btc)) if (v !== null) btcPrices.push(v);
  btc.medianUsd = median(btcPrices);
  const degraded = {
    fx: !fxR.ok,
    coingecko: !cgR.ok,
    binanceUs: !binR.ok,
    coinbase: !cbR.ok,
  };
  const detail = {
    fx: fxR.detail,
    coingecko: cgR.detail,
    binanceUs: binR.detail,
    coinbase: cbR.detail,
  };
  if (!fxR.ok && !cgR.ok && !binR.ok && !cbR.ok)
    throw Object.assign(new Error('markets_all_sources_failed'), { status: 502 });
  return {
    generatedAt: new Date().toISOString(),
    value: btc.medianUsd,
    unit: 'USD',
    fx: {
      base: fxR.value?.base ?? 'USD',
      date: fxR.value?.date ?? null,
      rates: fxR.value?.rates ?? {},
      degraded: degraded.fx,
      source: LEG_SOURCES.fx,
    },
    crypto: {
      btc,
      degraded: { coingecko: degraded.coingecko, binanceUs: degraded.binanceUs, coinbase: degraded.coinbase },
      sources: `${LEG_SOURCES.coingecko} · ${LEG_SOURCES.binanceUs} · ${LEG_SOURCES.coinbase}`,
    },
    degradedDetail: detail,
    source: 'Frankfurter · CoinGecko · Binance US · Coinbase',
    attribution: ATTRIBUTION,
    honesty:
      'FX is the ECB daily reference rate (updates ~16:00 CET, not live tick). ' +
      'BTC legs are live spot quotes; a degraded leg (incl. CoinGecko 429) is ' +
      'excluded from the median, never interpolated or invented.',
  };
}

const cache = makeCache(() => buildMarketsSnapshot(), CACHE_TTL_MS);

/** Mount the markets proxy. Mirrors the vaac/nwsAlerts provider shape. */
export function marketsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await cache.get(), 'public, max-age=300');
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        { error: 'markets_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }
  return buildProxy({ name: 'markets', route: '/api/markets', handler });
}

export const _marketsInternals = {
  extractFx,
  extractCoingecko,
  extractBinance,
  extractCoinbase,
  median,
  buildMarketsSnapshot,
  clearCaches: () => cache.clear(),
};
