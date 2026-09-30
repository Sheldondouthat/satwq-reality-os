/**
 * Live Signal Walls — pure model (no DOM, no Cesium, no fetch).
 *
 * Three walls fed by free, keyless, CORS-open public endpoints:
 *   #A USGS   https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson
 *   #B EONET  https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=20
 *   #C CG     https://api.coingecko.com/api/v3/simple/price?ids=...&vs_currencies=usd&include_24hr_change=true
 *
 * Truth tiers (visual badges in the wall):
 *   VERIFIED — source-direct live data (the raw row value from the feed)
 *   INFERRED — derived/computed from live data (24h change %, age strings)
 *   CONTEXT  — static reference (feed names, cadence, legend text)
 *
 * Honesty rule: null payloads stay null. A dead feed is rendered as
 * "feed down", never backfilled with synthetic or stale data.
 */

export const TIER = Object.freeze({
  VERIFIED: 'VERIFIED',
  INFERRED: 'INFERRED',
  CONTEXT: 'CONTEXT',
});

/** "M5.2" or "M?" on garbage. */
export function formatMag(m) {
  return Number.isFinite(m) ? `M${(Math.round(m * 10) / 10).toFixed(1)}` : 'M?';
}

/** "$84,752.39" / "$2,687.20" or "—" on garbage. */
export function formatUsd(v) {
  if (!Number.isFinite(v)) return '—';
  return (
    '$' +
    v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  );
}

/** "+1.58%" / "-0.42%" or "—" on garbage. */
export function formatChangePct(v) {
  if (!Number.isFinite(v)) return '—';
  const sign = v > 0 ? '+' : v < 0 ? '−' : '';
  return `${sign}${Math.abs(v).toFixed(2)}%`;
}

/** "3h ago" / "12m ago" / "just now" from an epoch-ms timestamp. */
export function ageStr(ts, now = Date.now()) {
  if (!Number.isFinite(ts) || ts <= 0) return 'time unknown';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/**
 * Normalize a USGS GeoJSON FeatureCollection into magnitude-sorted rows.
 * Returns null on a bad payload (feed down), [] when the feed is fine but
 * empty. Each row: {mag, place, timeMs, age, tier}.
 */
export function quakeRows(payload, maxRows = 12) {
  if (!payload || !Array.isArray(payload.features)) return null;
  const rows = [];
  for (const f of payload.features) {
    const p = f && f.properties ? f.properties : {};
    rows.push({
      mag: Number.isFinite(p.mag) ? p.mag : null,
      magLabel: formatMag(p.mag),
      place: typeof p.place === 'string' && p.place ? p.place : 'unknown location',
      timeMs: Number.isFinite(p.time) ? p.time : null,
      age: ageStr(p.time),
      tier: TIER.VERIFIED,
    });
  }
  rows.sort((a, b) => (b.mag ?? -Infinity) - (a.mag ?? -Infinity));
  return rows.slice(0, maxRows);
}

const EONET_CATEGORY_LABEL = {
  wildfires: 'Wildfire',
  volcanoes: 'Volcano',
  severeStorms: 'Severe storm',
  floods: 'Flood',
  earthquakes: 'Earthquake',
  drought: 'Drought',
  landslides: 'Landslide',
  seaLakeIce: 'Sea/lake ice',
  snow: 'Snow',
  dustHaze: 'Dust/haze',
  tempExtremes: 'Temp extreme',
  waterColor: 'Water color',
  manmade: 'Man-made',
};

/** Pretty EONET category id, e.g. "severeStorms" → "Severe storm". */
export function eonetCategoryLabel(id) {
  if (typeof id !== 'string' || !id) return 'Event';
  return EONET_CATEGORY_LABEL[id] || id;
}

/**
 * Normalize an EONET v3 events payload into category-grouped rows.
 * Returns null on a bad payload, [] when open. Each row:
 * {id, title, category, categoryLabel, tier}.
 */
export function eonetRows(payload, maxRows = 20) {
  if (!payload || !Array.isArray(payload.events)) return null;
  const rows = [];
  for (const e of payload.events.slice(0, maxRows)) {
    if (!e || typeof e !== 'object') continue;
    const cat = Array.isArray(e.categories) && e.categories[0] ? e.categories[0] : {};
    rows.push({
      id: typeof e.id === 'string' ? e.id : null,
      title: typeof e.title === 'string' && e.title ? e.title : 'untitled event',
      category: typeof cat.id === 'string' ? cat.id : 'unknown',
      categoryLabel: eonetCategoryLabel(cat.id),
      tier: TIER.VERIFIED,
    });
  }
  return rows;
}

/** Count rows per EONET category label, in first-seen order. */
export function eonetCategoryCounts(rows) {
  const out = [];
  const seen = new Map();
  for (const r of rows || []) {
    if (!seen.has(r.categoryLabel)) {
      seen.set(r.categoryLabel, out.length);
      out.push({ category: r.category, label: r.categoryLabel, count: 0 });
    }
    out[seen.get(r.categoryLabel)].count += 1;
  }
  return out;
}

const CRYPTO_ASSETS = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum' },
  { id: 'ripple', symbol: 'XRP', name: 'XRP' },
  { id: 'solana', symbol: 'SOL', name: 'Solana' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB' },
];

/** Asset list for the CoinGecko simple/price query. */
export function cryptoAssetIds() {
  return CRYPTO_ASSETS.map((a) => a.id).join(',');
}

/**
 * Normalize a CoinGecko simple/price payload into board rows.
 * Returns null on a bad payload. Each row:
 * {symbol, name, price, priceLabel, changePct, changeLabel, direction, tier}.
 */
export function cryptoRows(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const rows = [];
  for (const a of CRYPTO_ASSETS) {
    const rec = payload[a.id];
    const price = Number.isFinite(rec?.usd) ? rec.usd : null;
    const change = Number.isFinite(rec?.usd_24h_change) ? rec.usd_24h_change : null;
    rows.push({
      symbol: a.symbol,
      name: a.name,
      price,
      priceLabel: formatUsd(price),
      changePct: change,
      changeLabel: formatChangePct(change),
      direction: change === null ? 'flat' : change > 0 ? 'up' : change < 0 ? 'down' : 'flat',
      tier: TIER.VERIFIED,
    });
  }
  return rows;
}
