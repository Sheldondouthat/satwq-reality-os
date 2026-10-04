/**
 * Wave 9 (R2-7) — NASA Exoplanet Archive catalog provider.
 *
 * Backlog R2-7 ("NASA Exoplanet Archive"): the archive's IVOA TAP service
 * is free and keyless — no signup, no API key. Two ADQL queries per refresh:
 *   1. `select count(distinct pl_name) as n from ps` — confirmed-planet count
 *      (the `ps` Planetary Systems table carries multiple parameter rows per
 *      planet; DISTINCT collapses them. Verified live 2026-09-30: 6,372.)
 *   2. `select top {n} pl_name,hostname,disc_year,sy_dist,pl_orbper,pl_rade,
 *      pl_bmasse from ps where disc_year is not null
 *      order by disc_year desc,pl_name` — newest confirmed planets with
 *      distance (pc), orbital period (d), radius (R_earth), mass (M_earth).
 *
 * Columns verified live 2026-09-30 (all exist; `disc_method` does NOT exist
 * in `ps` — ORA-00904, so it is deliberately absent; never guess columns):
 *   pl_name, hostname, disc_year, sy_dist, pl_orbper, pl_rade, pl_bmasse.
 * Live sample: TOI-707 b (TOI-707, 2026, 130.96 pc, 52.7992 d, 2.398 R_earth,
 * mass null — unmeasured, never zero-filled).
 *
 * HONESTY, stated on the payload:
 *  - Confirmed planets only: `ps` is the Planetary Systems composite table.
 *    TOI/KOI candidates are excluded from both the count and the list.
 *  - `confirmedPlanets` = COUNT(DISTINCT pl_name) over `ps` — multiple
 *    parameter rows per planet are collapsed, never double-counted.
 *  - `disc_year` is the archive's discovery/announcement year, not a
 *    detection timestamp.
 *  - Orbital/physical parameters are null when unmeasured — never
 *    zero-filled (Number('')===0 trap guarded by numOrNull).
 *  - TAP returns HTTP 400 + VOTABLE XML on query errors — read as a bad
 *    shape and surfaced as an honest 502, never parsed as data.
 *
 * Routes:
 *   GET /api/exoplanets → { generatedAt, stale, confirmedPlanets, shown,
 *     maxDiscYear, latest, attribution, honesty }
 * Query: ?n=1..50 (default 15 — newest confirmed planets).
 *
 * Pages-safe: global fetch only, capped 256 KB read, redirect:'follow'
 * (workerd supports only 'follow'/'manual'; 'error' throws at the edge —
 * main 2ec4053), no node: imports, no WASM. Two upstream requests per
 * refresh — far under the Workers subrequest headroom rule.
 */

import { readResponseTextCapped } from '../common/http.js';

const TAP_BASE = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';
const USER_AGENT =
  'satwq-reality-os/1.0 (gods-eye-view; exoplanet archive layer; keyless)';
const UPSTREAM_TIMEOUT_MS = 30_000; // TAP ADQL can take a few seconds
const BODY_CAP_BYTES = 256 * 1024; // observed ~1 KB; generous headroom
const CACHE_TTL_MS = 24 * 3600_000; // catalog cadence — daily
const RETRY_COOLDOWN_MS = 60_000;
const STALE_MS = 14 * 24 * 3600_000; // >14d without a live refresh reads stale
const DEFAULT_N = 15;
const MAX_N = 50;

let docCache = null; // {at, parsed, key} — one upstream fetch pair per n-key
let docInflight = null;
let docFailedAt = -Infinity;
const payloadCache = new Map(); // query key -> {at, payload} — stale fallback per key
const PAYLOAD_CACHE_MAX = 16;

/** Number(null)===0 guard: null/NaN upstream numerics become null, never 0. */
function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function roundOrNull(v, decimals) {
  const n = numOrNull(v);
  if (n == null) return null;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function tapUrl(query) {
  const q = new URLSearchParams({ query, format: 'json' });
  return `${TAP_BASE}?${q.toString()}`;
}

const COUNT_QUERY = 'select count(distinct pl_name) as n from ps';

function latestQuery(n) {
  return (
    `select top ${n} pl_name,hostname,disc_year,sy_dist,pl_orbper,pl_rade,pl_bmasse ` +
    `from ps where disc_year is not null order by disc_year desc,pl_name`
  );
}

/**
 * Parse the TAP count response (JSON array, one row: {n}).
 * Throws {status:502} on bad shape (never returns a fabricated count).
 */
export function parseTapCount(text) {
  const fail = (msg) =>
    Object.assign(new Error(`exoplanets_invalid_count: ${msg}`), {
      status: 502,
    });
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw fail('not JSON (VOTABLE error page?)');
  }
  if (!Array.isArray(rows) || rows.length !== 1) throw fail('expected one row');
  const n = numOrNull(rows[0]?.n);
  if (n == null || !Number.isInteger(n) || n < 0) throw fail('bad count value');
  return n;
}

/**
 * Parse the TAP latest-discoveries response into planet rows. Pure.
 * Throws {status:502} on bad shape.
 */
export function parseTapLatest(text) {
  const fail = (msg) =>
    Object.assign(new Error(`exoplanets_invalid_latest: ${msg}`), {
      status: 502,
    });
  let rows;
  try {
    rows = JSON.parse(text);
  } catch {
    throw fail('not JSON (VOTABLE error page?)');
  }
  if (!Array.isArray(rows)) throw fail('expected a JSON array');
  return rows.map((r) => ({
    name:
      typeof r?.pl_name === 'string' && r.pl_name.trim()
        ? r.pl_name.trim()
        : null,
    host:
      typeof r?.hostname === 'string' && r.hostname.trim()
        ? r.hostname.trim()
        : null,
    discYear: numOrNull(r?.disc_year),
    distPc: roundOrNull(r?.sy_dist, 2),
    orbPeriodDays: roundOrNull(r?.pl_orbper, 4),
    radiusEarth: roundOrNull(r?.pl_rade, 4),
    massEarth: roundOrNull(r?.pl_bmasse, 4),
  }));
}

/**
 * Build the published payload from parsed TAP results. Pure.
 */
export function buildExoplanetsPayload(parsed, { nowMs, query }) {
  const fail = (msg, status = 502) =>
    Object.assign(new Error(`exoplanets_${msg}`), { status });
  const { confirmedPlanets, latest } = parsed;
  if (!Array.isArray(latest) || !latest.length) throw fail('no_latest_rows');
  const named = latest.filter((p) => p.name);
  if (!named.length) throw fail('no_named_planets');
  const years = named.map((p) => p.discYear).filter((y) => y != null);
  const maxDiscYear = years.length ? Math.max(...years) : null;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale: false,
    confirmedPlanets,
    shown: named.length,
    requested: query.n,
    maxDiscYear,
    latest: named,
    attribution:
      'NASA Exoplanet Archive — Planetary Systems (ps) table via IVOA TAP; keyless, no signup',
    honesty: {
      confirmedOnly:
        'confirmed planets only — the ps Planetary Systems composite table; TOI/KOI candidates are excluded from the count and the list',
      countSemantics:
        'confirmedPlanets = COUNT(DISTINCT pl_name): the ps table carries multiple parameter rows per planet; they are collapsed, never double-counted',
      discYear:
        "disc_year is the archive's discovery/announcement year, not a detection timestamp",
      nulls:
        'orbital/physical parameters are null when unmeasured — never zero-filled',
      cadence: 'the archive grows as papers publish; results cached up to 24h',
    },
  };
}

function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const nRaw = params.get('n');
  let n = DEFAULT_N;
  if (nRaw != null) {
    const v = Number(nRaw.trim());
    if (!Number.isInteger(v) || v < 1 || v > MAX_N)
      throw Object.assign(new Error(`exoplanets_bad_n: ${nRaw}`), {
        status: 400,
      });
    n = v;
  }
  return { n, key: `n=${n}` };
}

async function fetchJson(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    // TAP answers bad ADQL with HTTP 400 + VOTABLE XML — an upstream fault,
    // never a shape we parse as data.
    if (!res.ok)
      throw Object.assign(new Error(`exoplanets_upstream_${res.status}`), {
        status: 502,
      });
    return await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstream(fetchImpl, n) {
  const countText = await fetchJson(fetchImpl, tapUrl(COUNT_QUERY));
  const confirmedPlanets = parseTapCount(countText); // throws {status:502} on bad shape
  const latestText = await fetchJson(fetchImpl, tapUrl(latestQuery(n)));
  const latest = parseTapLatest(latestText); // throws {status:502} on bad shape
  return { confirmedPlanets, latest };
}

function sendJson(res, status, body, cacheControl = 'public, max-age=86400') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

async function getDoc(fetchImpl, n, nowMs, signal) {
  const key = `n=${n}`;
  if (docCache && docCache.key === key && nowMs - docCache.at < CACHE_TTL_MS)
    return docCache.parsed;
  signal?.throwIfAborted?.();
  if (!docInflight) {
    // Retry gate fires only after a FAILED doc fetch — the failure is an
    // upstream outage, so classify as 502 (honest degrade), never 500.
    if (nowMs - docFailedAt < RETRY_COOLDOWN_MS) {
      const gate = new Error('exoplanets_retry_later');
      gate.status = 502;
      throw gate;
    }
    docInflight = fetchUpstream(fetchImpl, n)
      .then((parsed) => {
        docCache = { at: nowMs, parsed, key };
        docFailedAt = -Infinity;
        return parsed;
      })
      .catch((error) => {
        docFailedAt = nowMs;
        throw error;
      })
      .finally(() => {
        docInflight = null;
      });
  }
  const wait = docInflight;
  if (!signal) return wait;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const detach = () => signal.removeEventListener('abort', abort);
    wait.then(detach, detach);
  });
  return Promise.race([wait, cancelled]);
}

function rememberPayload(key, payload, nowMs) {
  payloadCache.set(key, { at: nowMs, payload });
  while (payloadCache.size > PAYLOAD_CACHE_MAX) {
    const oldest = payloadCache.keys().next().value;
    payloadCache.delete(oldest);
  }
}

async function getPayload(fetchImpl, query, nowMs, signal) {
  try {
    const parsed = await getDoc(fetchImpl, query.n, nowMs, signal);
    const payload = buildExoplanetsPayload(parsed, { nowMs, query });
    rememberPayload(query.key, payload, nowMs);
    return payload;
  } catch (error) {
    // Stale fallback is key-scoped: only serve a payload captured for THIS query.
    const hit = payloadCache.get(query.key);
    if (hit && nowMs - hit.at <= STALE_MS)
      return {
        ...hit.payload,
        generatedAt: new Date(nowMs).toISOString(),
        stale: true,
      };
    throw error;
  }
}

export function exoplanetsProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      let query;
      try {
        query = parseQuery(req.url);
      } catch (error) {
        return sendJson(
          res,
          400,
          { error: 'exoplanets_bad_request', detail: error.message },
          'no-store',
        );
      }
      try {
        const payload = await getPayload(
          fetchImpl,
          query,
          now(),
          controller.signal,
        );
        sendJson(res, 200, payload);
      } catch (error) {
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?|fetch failed/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          {
            error: 'exoplanets_unavailable',
            detail: error?.message ?? 'unknown',
          },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'exoplanets',
    configureServer({ middlewares }) {
      middlewares.use('/api/exoplanets', handler);
    },
  };
}

/** Test-only: reset module caches between tests. */
export function clearExoplanetsCaches() {
  docCache = null;
  docInflight = null;
  docFailedAt = -Infinity;
  payloadCache.clear();
}
