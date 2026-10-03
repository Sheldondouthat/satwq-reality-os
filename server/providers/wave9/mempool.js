/**
 * Wave 9 — mempool.space Bitcoin network state (fees / congestion / chain tip).
 *
 * Upstreams (all keyless, verified 200 from VM 2026-10-03):
 *   GET https://mempool.space/api/blocks/tip/height -> plain-text chain-tip height
 *   GET https://mempool.space/api/blocks            -> last ~10 blocks (tip: height, timestamp, tx_count, size, weight)
 *   GET https://mempool.space/api/v1/fees/recommended -> {fastestFee,halfHourFee,hourFee,economyFee,minimumFee} sat/vB
 *   GET https://mempool.space/api/mempool           -> {count, vsize, total_fee, fee_histogram}
 *
 * 4 subrequests per refresh, sequential, under the Workers 50 cap.
 *
 * HONESTY: fee projections are mempool.space's inclusion-time estimates
 * (sat/vB), never a confirmation guarantee. Mempool state reflects
 * mempool.space's own node view — other nodes see slightly different counts.
 * The tip timestamp is the block's own timestamp, not when we observed it.
 * No price data lives here (prices are /api/markets' job). Nulls are never
 * zero-filled.
 */
const UPSTREAM_BASE = 'https://mempool.space/api';
const ENDPOINTS = {
  height: `${UPSTREAM_BASE}/blocks/tip/height`,
  blocks: `${UPSTREAM_BASE}/blocks`,
  fees: `${UPSTREAM_BASE}/v1/fees/recommended`,
  mempool: `${UPSTREAM_BASE}/mempool`,
};
const USER_AGENT = 'satyq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const BODY_CAP_BYTES = 2_000_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const STALE_MS = 7 * 24 * 3600 * 1000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const CACHE_CONTROL = 'public, max-age=600';

const MEMPOOL_HONESTY = {
  feesAreProjections:
    'Recommended fees (sat/vB) are mempool.space inclusion-time projections (fastest / ~30 min / ~1 h / economy) — estimates, never a confirmation guarantee.',
  nodeView:
    "Mempool counts reflect mempool.space's own node view; other nodes see slightly different counts.",
  tipTimestamp: "The tip block timestamp is the block's own timestamp, not when we observed it.",
  noPrices: 'No fiat data here — prices are the /api/markets layer.',
  nullsNeverZero: 'Missing values read null, never 0.',
  attribution: 'Data: mempool.space (keyless public API).',
};

export function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Parse the plain-text height body. Returns an integer or null. */
export function parseHeightText(text) {
  const n = numOrNull(text);
  return n == null ? null : Math.trunc(n);
}

/** Parse the /blocks array. Returns the tip block's live fields or null. */
export function parseTipBlock(blocks) {
  if (!Array.isArray(blocks) || blocks.length === 0) return null;
  const tip = blocks[0];
  if (!tip || typeof tip !== 'object') return null;
  return {
    height: numOrNull(tip.height) == null ? null : Math.trunc(numOrNull(tip.height)),
    hash: typeof tip.id === 'string' && tip.id ? tip.id : null,
    timestamp: numOrNull(tip.timestamp) == null ? null : Math.trunc(numOrNull(tip.timestamp)),
    txCount: numOrNull(tip.tx_count) == null ? null : Math.trunc(numOrNull(tip.tx_count)),
    sizeBytes: numOrNull(tip.size) == null ? null : Math.trunc(numOrNull(tip.size)),
    weight: numOrNull(tip.weight) == null ? null : Math.trunc(numOrNull(tip.weight)),
    difficulty: numOrNull(tip.difficulty),
  };
}

/** Parse the /v1/fees/recommended body. Returns sat/vB numbers or nulls. */
export function parseFees(body) {
  if (!body || typeof body !== 'object') return null;
  return {
    fastest: numOrNull(body.fastestFee),
    halfHour: numOrNull(body.halfHourFee),
    hour: numOrNull(body.hourFee),
    economy: numOrNull(body.economyFee),
    minimum: numOrNull(body.minimumFee),
  };
}

/** Parse the /mempool body. Returns counts or nulls (histogram not shipped). */
export function parseMempool(body) {
  if (!body || typeof body !== 'object') return null;
  const txCount = numOrNull(body.count);
  return {
    txCount: txCount == null ? null : Math.trunc(txCount),
    vsizeBytes: numOrNull(body.vsize) == null ? null : Math.trunc(numOrNull(body.vsize)),
    totalFeeSats: numOrNull(body.total_fee) == null ? null : Math.trunc(numOrNull(body.total_fee)),
  };
}

export function buildPayload(parts, stale) {
  const { height, tip, fees, mempool } = parts;
  return {
    generatedAt: new Date().toISOString(),
    upstream: Object.values(ENDPOINTS),
    stale: !!stale,
    height,
    tip,
    fees,
    mempool,
    honesty: MEMPOOL_HONESTY,
  };
}

// --- fetch machinery (wave9 conventions) ---

async function fetchCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json, text/plain, */*' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`mempool_upstream_${response.status}`), { status: 502 });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('mempool_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(new Error(`mempool_fetch_failed: ${error?.message ?? 'unknown'}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

// --- caches (mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;

async function getPayload() {
  const key = 'all';
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    if (now - docFailedAt < RETRY_COOLDOWN_MS && hit && now - hit.at < STALE_MS) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const heightText = await fetchCapped(ENDPOINTS.height, BODY_CAP_BYTES);
        const blocksJson = await fetchCapped(ENDPOINTS.blocks, BODY_CAP_BYTES);
        const feesJson = await fetchCapped(ENDPOINTS.fees, BODY_CAP_BYTES);
        const mempoolJson = await fetchCapped(ENDPOINTS.mempool, BODY_CAP_BYTES);
        const height = parseHeightText(heightText);
        const tip = parseTipBlock(JSON.parse(blocksJson));
        const fees = parseFees(JSON.parse(feesJson));
        const mempool = parseMempool(JSON.parse(mempoolJson));
        if (height == null && tip == null && fees == null && mempool == null) {
          throw Object.assign(new Error('mempool_all_parts_null'), { status: 502 });
        }
        const payload = buildPayload({ height, tip, fees, mempool }, false);
        payloadCache.set(key, { at: Date.now(), payload });
        return { payload, stale: false };
      } catch (error) {
        docFailedAt = Date.now();
        if (hit && Date.now() - hit.at < STALE_MS) return { payload: hit.payload, stale: true };
        throw error;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = CACHE_CONTROL) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 mempool.space Bitcoin network-state proxy. */
export function mempoolProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const { payload, stale } = await getPayload();
      sendJson(res, 200, stale ? { ...payload, stale: true } : payload);
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'mempool_unavailable',
        detail: error?.message ?? 'unknown',
        honesty: { attribution: 'Data: mempool.space (keyless public API).' },
      }, 'no-store');
    }
  }

  return {
    name: 'mempool',
    configureServer({ middlewares }) {
      middlewares.use('/api/mempool', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/mempool', handler);
    },
  };
}

export const _mempoolInternals = {
  ENDPOINTS,
  CACHE_TTL_MS,
  MEMPOOL_HONESTY,
  parseHeightText,
  parseTipBlock,
  parseFees,
  parseMempool,
  buildPayload,
  numOrNull,
  resetCache: () => { payloadCache.clear(); inflight.clear(); docFailedAt = -Infinity; },
};
