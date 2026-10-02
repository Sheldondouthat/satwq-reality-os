/**
 * Wave 10 — Operation 500 generic spec-driven provider engine.
 *
 * One engine, N declarative specs. Each spec describes ONE keyless upstream
 * URL plus a JSONPath-ish extraction ({items, map}) that turns the upstream
 * payload into a uniform item list. Specs live as data in
 * server/providers/wave10/specs/*.json; scripts/surge-generate.mjs compiles
 * them into specs.mjs + api/<id>.js mounts + registry entries + tests.
 *
 * Design constraints (carried from waves 5–9):
 * - Keyless, no new dependencies, Pages-safe (global fetch only, capped
 *   reads, redirect:'follow' — workerd throws on 'error' (main 2ec4053),
 *   no node: imports, no WASM, no fs).
 * - ONE upstream subrequest per route invocation (Workers 50-subrequest cap).
 * - NEVER fake data: empty/unresolvable extraction → honest 502.
 * - numOrNull guards on every numeric field (Number('')===0 trap).
 * - Honest stale/degraded labels on every payload.
 *
 * Spec schema (see scripts/surge-probe.mjs for the authoring contract):
 * {
 *   id: 'usgs-water-tx',            // [a-z0-9-]{1,48}, route /api/<id>
 *   title: 'USGS Water — Texas streamflow',
 *   url: 'https://…',               // single keyless GET
 *   headers: { 'User-Agent': '…' }, // optional, merged over default UA
 *   ttlSeconds: 3600,               // cache TTL (default 3600)
 *   timeoutMs: 20000,               // upstream timeout (default 20000)
 *   bodyCapBytes: 2097152,          // read cap (default 2 MiB)
 *   extract: {
 *     items: '$.value.timeSeries',   // path to the item array
 *     limit: 40,                    // max items surfaced (default 50)
 *     map: { name: '$.sourceInfo.siteName', … },  // item field → path
 *     numbers: ['lat','lon','value'] // fields run through numOrNull
 *   },
 *   required: ['name'],             // fields that must resolve on ≥1 item
 *   source: 'USGS Water Services (NWIS)',
 *   attribution: 'Data: U.S. Geological Survey, NWIS — keyless.',
 *   units: { value: 'ft3/s' },      // optional
 *   honesty: '…',                   // staleness/cadence caveats (required)
 *   verifiedAt: '2026-10-02',       // probe date (required)
 *   verifiedBy: 'surge-500 batch 1' // (required)
 * }
 *
 * Path grammar (resolvePath): '$' root, '.name' object keys,
 * '[N]' array indices. No wildcards, no filters, no eval.
 */

const DEFAULT_UA = 'satwq-reality-os/1.0 (gods-eye-view; surge-500 layer; keyless)';
const DEFAULT_TTL_MS = 3600_000;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_BODY_CAP = 2 * 1024 * 1024;
const DEFAULT_LIMIT = 50;
const RETRY_COOLDOWN_MS = 60_000;
const STALE_MULTIPLIER = 14; // stale fallback window = 14 × TTL

export const SPEC_ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const FAKE_MARKERS = ['todo', 'lorem', 'example.com', 'placeholder', 'xxx', 'changeme'];

/** Number(null)===0 guard: null/NaN/empty upstream numerics become null, never 0. */
export function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve a simple path ('$.a.b[0].c') against a JSON value.
 * Returns undefined when any segment is missing. Pure.
 */
export function resolvePath(root, path) {
  if (typeof path !== 'string' || !path.startsWith('$')) return undefined;
  const rest = path.slice(1);
  if (rest === '') return root;
  const segments = [];
  const re = /(?:\.([A-Za-z0-9_-]+))|(?:\[(\d+)\])/g;
  let m;
  let consumed = 0;
  while ((m = re.exec(rest)) !== null) {
    if (m.index !== consumed) return undefined; // gap = unsupported syntax
    consumed = m.index + m[0].length;
    segments.push(m[1] !== undefined ? m[1] : Number(m[2]));
  }
  if (consumed !== rest.length) return undefined;
  let cur = root;
  for (const seg of segments) {
    if (cur == null) return undefined;
    cur = cur[seg];
  }
  return cur;
}

/** Validate a spec object. Throws on the first violation. Pure. */
export function validateSpec(spec) {
  const fail = (msg) => { throw new Error(`surge_spec_invalid: ${msg}`); };
  if (!spec || typeof spec !== 'object') fail('spec must be an object');
  if (!SPEC_ID_RE.test(spec.id || '')) fail(`bad id '${spec.id}'`);
  if (typeof spec.title !== 'string' || spec.title.trim() === '') fail('title required');
  if (typeof spec.url !== 'string' || !/^https:\/\//.test(spec.url)) fail('url must be https');
  if (spec.headers != null && (typeof spec.headers !== 'object' || Array.isArray(spec.headers))) fail('headers must be an object');
  const ex = spec.extract;
  if (!ex || typeof ex !== 'object') fail('extract required');
  if (typeof ex.items !== 'string' || !ex.items.startsWith('$')) fail('extract.items must be a $-path');
  if (!ex.map || typeof ex.map !== 'object' || Array.isArray(ex.map)) fail('extract.map required');
  const mapKeys = Object.keys(ex.map);
  if (mapKeys.length === 0) fail('extract.map must not be empty');
  for (const [k, p] of Object.entries(ex.map)) {
    if (typeof p !== 'string' || !p.startsWith('$')) fail(`map field '${k}' must be a $-path`);
  }
  if (ex.numbers != null && !Array.isArray(ex.numbers)) fail('extract.numbers must be an array');
  if (ex.limit != null && (!Number.isInteger(ex.limit) || ex.limit < 1 || ex.limit > 200)) fail('extract.limit 1..200');
  if (typeof spec.source !== 'string' || spec.source.trim() === '') fail('source required');
  if (typeof spec.attribution !== 'string' || spec.attribution.trim() === '') fail('attribution required');
  if (typeof spec.honesty !== 'string' || spec.honesty.trim() === '') fail('honesty required');
  if (typeof spec.verifiedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(spec.verifiedAt)) fail('verifiedAt YYYY-MM-DD required');
  if (typeof spec.verifiedBy !== 'string' || spec.verifiedBy.trim() === '') fail('verifiedBy required');
  if (spec.honestEmpty != null && typeof spec.honestEmpty !== 'boolean') fail('honestEmpty must be a boolean');
  const blob = JSON.stringify(spec).toLowerCase();
  for (const marker of FAKE_MARKERS) {
    if (blob.includes(marker)) fail(`fake-data marker '${marker}'`);
  }
  return true;
}

/**
 * Extract the item array from an upstream JSON payload per spec.
 * Returns the array (possibly empty). Pure.
 */
export function extractItems(spec, payload) {
  const items = resolvePath(payload, spec.extract.items);
  if (!Array.isArray(items)) return [];
  const limit = spec.extract.limit ?? DEFAULT_LIMIT;
  return items.slice(0, limit);
}

/**
 * Map one upstream item to the surfaced row. Pure.
 * Fields listed in extract.numbers go through numOrNull.
 */
export function applyMap(spec, item) {
  const row = {};
  const numbers = new Set(spec.extract.numbers ?? []);
  for (const [field, path] of Object.entries(spec.extract.map)) {
    const v = resolvePath(item, path);
    row[field] = numbers.has(field) ? numOrNull(v) : (v ?? null);
    if (typeof row[field] === 'string') row[field] = row[field].trim().slice(0, 500);
  }
  return row;
}

/**
 * Filter rows: drop rows where every `required` field is null.
 * Returns {rows, dropped}. Pure.
 */
export function filterRequired(spec, rows) {
  const required = spec.required ?? [];
  if (required.length === 0) return { rows, dropped: 0 };
  const kept = [];
  let dropped = 0;
  for (const row of rows) {
    if (required.every((f) => row[f] == null)) dropped++;
    else kept.push(row);
  }
  return { rows: kept, dropped };
}

/** Build the public payload envelope. Pure apart from generatedAt. */
export function buildPayload(spec, rows, stale) {
  return {
    generatedAt: new Date().toISOString(),
    stale: Boolean(stale),
    id: spec.id,
    title: spec.title,
    source: spec.source,
    attribution: spec.attribution,
    units: spec.units ?? {},
    count: rows.length,
    items: rows,
    honesty: spec.honesty,
  };
}

async function fetchJsonCapped(spec) {
  const controller = new AbortController();
  const timeoutMs = spec.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(spec.url, {
      signal: controller.signal,
      // workerd supports only 'follow'/'manual'; 'error' throws (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json', ...(spec.headers ?? {}) },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`surge_upstream_${response.status}`), { status: 502 });
    }
    const buffer = await response.arrayBuffer();
    const cap = spec.bodyCapBytes ?? DEFAULT_BODY_CAP;
    if (buffer.byteLength > cap) throw Object.assign(new Error('surge_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError) throw Object.assign(new Error('surge_upstream_bad_json'), { status: 502 });
    throw Object.assign(new Error(`surge_fetch_failed: ${error?.message ?? 'unknown'}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

// --- per-spec caches (id -> {at, payload}); mirrors wave9 conventions ---
const payloadCache = new Map();
const inflight = new Map();
const failedAt = new Map();
const PAYLOAD_CACHE_MAX = 64;

function ttlMs(spec) {
  return (spec.ttlSeconds ?? 3600) * 1000;
}

async function getPayload(spec) {
  const key = spec.id;
  const now = Date.now();
  const ttl = ttlMs(spec);
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < ttl) return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    const lastFail = failedAt.get(key) ?? -Infinity;
    if (now - lastFail < RETRY_COOLDOWN_MS && hit && now - hit.at < ttl * STALE_MULTIPLIER) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      const upstream = await fetchJsonCapped(spec);
      const rawItems = extractItems(spec, upstream);
      const mapped = rawItems.map((item) => applyMap(spec, item));
      const { rows, dropped } = filterRequired(spec, mapped);
      if (rows.length === 0) {
        failedAt.set(key, Date.now());
        if (hit && now - hit.at < ttl * STALE_MULTIPLIER) return { payload: hit.payload, stale: true };
        throw Object.assign(new Error(`surge_no_rows: extracted=${rawItems.length} dropped=${dropped}`), { status: 502 });
      }
      const payload = buildPayload(spec, rows, false);
      if (payloadCache.size >= PAYLOAD_CACHE_MAX) payloadCache.delete(payloadCache.keys().next().value);
      payloadCache.set(key, { at: Date.now(), payload });
      failedAt.delete(key);
      return { payload, stale: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=3600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/**
 * Build the provider plugin for one spec id.
 * The spec map is injected (generated specs.mjs) to keep this module
 * importable without fs — edge-safe.
 */
export function specProxy(id, specMap) {
  // Accept either a spec map ({id: spec}) or a single spec object.
  const spec = specMap && typeof specMap === 'object' && typeof specMap.id === 'string'
    ? specMap
    : specMap?.[id];
  if (!spec) throw new Error(`surge_unknown_spec: ${id}`);
  // Validate before the id check: a malformed spec object must report
  // surge_spec_invalid even when its id also mismatches (pinned by
  // src/surge/generic.test.mjs 'specProxy builds the plugin interface').
  validateSpec(spec);
  if (spec.id !== id) throw new Error(`surge_unknown_spec: ${id}`);

  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const { payload, stale } = await getPayload(spec);
      sendJson(res, 200, stale ? { ...payload, stale: true } : payload,
        `public, max-age=${Math.min(spec.ttlSeconds ?? 3600, 86400)}`);
    } catch (error) {
      const upstreamFail = error?.status === 502 || /abort/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: `${spec.id}_unavailable`,
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: id,
    configureServer({ middlewares }) {
      middlewares.use(`/api/${id}`, handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use(`/api/${id}`, handler);
    },
  };
}

export const _surgeInternals = {
  resolvePath,
  validateSpec,
  extractItems,
  applyMap,
  filterRequired,
  buildPayload,
  numOrNull,
  SPEC_ID_RE,
  clearCaches: () => { payloadCache.clear(); inflight.clear(); failedAt.clear(); },
};
