/**
 * Wave 5 — markets ticker model (pure, no Cesium, no DOM).
 *
 * FX rates + BTC spot legs with per-source degraded presentation.
 */

/** "$84,752.39" or "—" on garbage. */
export function formatUsd(v) {
  if (!Number.isFinite(v)) return '—';
  return (
    '$' +
    v.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/** "0.8770" for FX rates or "—" on garbage. */
export function formatRate(v) {
  if (!Number.isFinite(v)) return '—';
  return `${Math.round(v * 10_000) / 10_000}`;
}

/**
 * Names of BTC legs that are live vs degraded, in display order.
 * Returns {live:[{key,price}], degraded:[key]}.
 */
export function legStatus(btc, degraded) {
  const keys = ['coingecko', 'binanceUs', 'coinbase'];
  const live = [];
  const dead = [];
  for (const key of keys) {
    const price = Number.isFinite(btc?.[key]) ? btc[key] : null;
    if (degraded?.[key] || price === null) dead.push(key);
    else live.push({ key, price });
  }
  return { live, degraded: dead };
}

const LEG_LABEL = {
  coingecko: 'CoinGecko',
  binanceUs: 'Binance US',
  coinbase: 'Coinbase',
};

/** One-line ticker summary of a /api/markets payload; null on bad payload. */
export function tickerSummary(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const eur = Number.isFinite(payload.fx?.rates?.EUR)
    ? payload.fx.rates.EUR
    : null;
  const { live, degraded } = legStatus(
    payload.crypto?.btc,
    payload.crypto?.degraded,
  );
  return {
    btcMedian: formatUsd(payload.value),
    fxEur: eur !== null ? `€1 = ${formatRate(1 / eur)}` : null, // EUR→USD cross
    fxDate: payload.fx?.date ?? null,
    fxDegraded: payload.fx?.degraded ?? true,
    liveLegs: live.map((l) => ({
      label: LEG_LABEL[l.key],
      price: formatUsd(l.price),
    })),
    degradedLegs: degraded.map((k) => LEG_LABEL[k]),
    anyDegraded: degraded.length > 0 || (payload.fx?.degraded ?? true),
  };
}
