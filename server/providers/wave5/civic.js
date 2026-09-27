/**
 * Wave 5 — Civic knowledge ticker proxy (keyless).
 *
 * Merges three civic data streams into one trimmed payload:
 *   #172 Federal Register — recent documents (documents.json, US public domain)
 *   #177 Hacker News     — front-page top stories (Algolia-free Firebase API)
 *   #171 NYC 311         — recent service requests (Socrata, NYC open data)
 *
 * All three upstreams serve no CORS headers for browsers, so this proxy
 * trims each to the fields the dock ticker needs and caches the merge.
 *
 * Routes:
 *   GET /api/civic → {generatedAt, items:[...], degradedSources:[], source, attribution}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' (workerd: 'error' throws at edge, main 2ec4053), no node: imports, no WASM).
 */

const FR_HOST = 'www.federalregister.gov';
const HN_HOST = 'hacker-news.firebaseio.com';
const NYC311_HOST = 'data.cityofnewyork.us';

const FR_URL = `https://${FR_HOST}/api/v1/documents.json?per_page=5`;
const HN_TOP_URL = `https://${HN_HOST}/v0/topstories.json`;
const HN_ITEM_URL = (id) => `https://${HN_HOST}/v0/item/${id}.json`;
const NYC311_URL = `https://${NYC311_HOST}/resource/erm2-nwe9.json?$limit=5&$order=created_date%20DESC`;

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const HN_ITEM_COUNT = 8;
const TEXT_CAP = 280;
const USER_AGENT = 'Gods Eye View (public civic data context)';

let cache = null; // {at, payload}
let inflight = null;

function assertPinnedHost(url, host) {
  if (new URL(url).host !== host)
    throw Object.assign(new Error(`civic_unexpected_host_${host}`), { status: 502 });
}

async function fetchJsonCapped(url, host, signal) {
  assertPinnedHost(url, host);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`civic_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('civic_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function capText(value) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim();
  return s.length > TEXT_CAP ? s.slice(0, TEXT_CAP) + '…' : s;
}

function trimFederalRegister(doc) {
  return {
    feed: 'federal-register',
    id: String(doc?.document_number ?? ''),
    kind: String(doc?.type ?? ''),
    title: capText(doc?.title),
    summary: capText(doc?.abstract),
    published: doc?.publication_date ?? null,
    url: String(doc?.html_url ?? ''),
  };
}

function trimHnItem(item) {
  return {
    feed: 'hacker-news',
    id: String(item?.id ?? ''),
    kind: String(item?.type ?? 'story'),
    title: capText(item?.title),
    summary: item?.url ? capText(String(item.url)) : '',
    score: Number.isFinite(item?.score) ? item.score : null,
    by: String(item?.by ?? ''),
    published: Number.isFinite(item?.time) ? new Date(item.time * 1000).toISOString() : null,
    comments: Number.isFinite(item?.descendants) ? item.descendants : null,
    url: item?.url ? String(item.url) : `https://news.ycombinator.com/item?id=${item?.id ?? ''}`,
  };
}

function trim311(row) {
  const lat = Number.parseFloat(row?.latitude);
  const lon = Number.parseFloat(row?.longitude);
  return {
    feed: 'nyc-311',
    id: String(row?.unique_key ?? ''),
    kind: String(row?.complaint_type ?? ''),
    title: capText(row?.descriptor || row?.complaint_type),
    summary: capText(row?.agency ? `${row.agency} · ${row?.borough ?? ''}`.trim() : ''),
    published: row?.created_date ?? null,
    url: row?.unique_key
      ? `https://portal.311.nyc.gov/article/?kanumber=${encodeURIComponent(String(row.unique_key))}`
      : '',
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  };
}

async function fetchFederalRegister() {
  const upstream = await fetchJsonCapped(FR_URL, FR_HOST, null);
  const results = Array.isArray(upstream?.results) ? upstream.results : [];
  return results.map(trimFederalRegister).filter((d) => d.id && d.title);
}

async function fetchHackerNews() {
  const ids = await fetchJsonCapped(HN_TOP_URL, HN_HOST, null);
  const top = (Array.isArray(ids) ? ids : []).slice(0, HN_ITEM_COUNT);
  const stories = await Promise.all(
    top.map((id) => fetchJsonCapped(HN_ITEM_URL(id), HN_HOST, null).catch(() => null)),
  );
  return stories.filter(Boolean).map(trimHnItem).filter((s) => s.id && s.title);
}

async function fetchNyc311() {
  const upstream = await fetchJsonCapped(NYC311_URL, NYC311_HOST, null);
  const rows = Array.isArray(upstream) ? upstream : [];
  return rows.map(trim311).filter((r) => r.id && r.kind);
}

const SOURCES = [
  { name: 'federal-register', fetch: fetchFederalRegister },
  { name: 'hacker-news', fetch: fetchHackerNews },
  { name: 'nyc-311', fetch: fetchNyc311 },
];

export function trimCivicPayload(sourceResults) {
  const items = [];
  const degradedSources = [];
  for (const { name, result } of sourceResults) {
    if (result instanceof Error) {
      degradedSources.push(name);
    } else {
      items.push(...result);
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    count: items.length,
    items,
    degradedSources,
    source: 'Federal Register API + Hacker News API + NYC Open Data (311)',
    attribution:
      'Federal Register (US public domain) · Hacker News (Y Combinator) · NYC 311 (NYC Open Data)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(
      SOURCES.map(async ({ name, fetch }) => {
        try {
          return { name, result: await fetch() };
        } catch (error) {
          return { name, result: error instanceof Error ? error : new Error('unknown') };
        }
      }),
    )
      .then((sourceResults) => {
        const payload = trimCivicPayload(sourceResults);
        if (payload.degradedSources.length >= SOURCES.length)
          throw Object.assign(new Error('civic_all_sources_unavailable'), { status: 502 });
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=900') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the civic ticker proxy. Mirrors the nwsAlerts provider shape. */
export function civicProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'civic_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'civic',
    configureServer({ middlewares }) {
      middlewares.use('/api/civic', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/civic', handler);
    },
  };
}

export const _civicInternals = {
  trimFederalRegister,
  trimHnItem,
  trim311,
  trimCivicPayload,
  clearCaches: () => { cache = null; inflight = null; },
};
