/**
 * Wave 9 (R2-4) — U.S. Drought Monitor weekly summary provider.
 *
 * Backlog R2-4 ("US Drought Monitor"): USDM statistics are free and keyless
 * through UNL's documented REST service (WebServiceInfo.aspx). The national
 * summary endpoint returns one CSV per query window: one row per drought
 * category (D1–D4) per weekly map, with area %, area (sq mi), affected
 * population, and population %. A trailing-N-week window therefore carries
 * both the current map AND the previous week — so the provider computes
 * week-over-week deltas itself from real consecutive rows (labeled as
 * provider-computed; the upstream PercentChangeFromWAve column reads 0.00
 * in this query mode and is not trusted).
 *
 * HONESTY, stated on the payload:
 *  - Weekly cadence: USDM maps are dated Tuesdays and released Thursdays.
 *    `mapDate` is the map's own date; `mapAgeDays` says how old it is.
 *  - Category rows are CUMULATIVE ("at least D1"): the D1 row's areaPercent
 *    is the share of the US in D1-or-worse drought, NOT the D1-only band.
 *  - This UNL statistics variant returns only D1–D4 (drought categories);
 *    D0/None are not exposed here, and are never synthesized.
 *  - State-level AOI queries (StateStatistics, aoi=VA/Virginia) returned
 *    HTTP 200 with empty bodies during verification (2026-09-30), so the
 *    provider is national-only. No state breakdown is claimed.
 *  - weekOverWeek deltas are provider-computed from consecutive weekly
 *    rows, in percentage POINTS (not percent change).
 *
 * Upstream (verified live 2026-09-30 from the build VM, HTTP 200, ~0.5–1 KB
 * CSV, keyless, no signup):
 *   https://usdmdataservices.unl.edu/api/USStatistics/GetBasicStatisticsByAreaPercent
 *   ?aoi=TOTAL&dx=1&DxLevelThresholdFrom=0&DxLevelThresholdTo=70
 *   &startdate=M/D/YYYY&enddate=M/D/YYYY&statisticsType=1
 * Sample (MapDate 2026-09-22): D1 49.65% / 1,787,430.62 sq mi / 105.6M people;
 * D2 28.10%; D3 10.17%; D4 1.77%.
 *
 * Routes:
 *   GET /api/usdm → { generatedAt, stale, mapDate, mapAgeDays, weeks,
 *     categories, summary, attribution, honesty }
 * Query: ?weeks=1..8 (default 2 — current map + previous week for deltas).
 *
 * Pages-safe: global fetch only, capped 64 KB read, redirect:'follow'
 * (workerd supports only 'follow'/'manual'; 'error' throws at the edge —
 * main 2ec4053), no node: imports, no WASM. One upstream request per
 * refresh — far under the Workers subrequest headroom rule.
 */

import { readResponseTextCapped } from '../common/http.js';

const API_BASE =
  'https://usdmdataservices.unl.edu/api/USStatistics/GetBasicStatisticsByAreaPercent';
const USER_AGENT =
  'satwq-reality-os/1.0 (gods-eye-view; USDM drought layer; keyless)';
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 64 * 1024; // observed ~1 KB; generous headroom
const CACHE_TTL_MS = 6 * 3600_000; // weekly cadence — 6h TTL is plenty
const RETRY_COOLDOWN_MS = 60_000;
const STALE_MS = 9 * 24 * 3600_000; // >9d without a new map reads stale
const MAX_WEEKS = 8;
const DEFAULT_WEEKS = 2;
const LEVELS = ['D1', 'D2', 'D3', 'D4'];

let docCache = null; // {at, parsed, key} — one upstream fetch per weeks-key
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

/** Parse a locale-formatted number ("1,787,430.62") — commas stripped first. */
function parseLocaleNum(v) {
  if (v == null) return null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    return numOrNull(t.replace(/,/g, ''));
  }
  return numOrNull(v);
}

/** Quote-aware CSV line split (handles "1,787,430.62" and "" escapes). Pure. */
export function parseCsvLine(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

const HEADER = [
  'AreaOfInterest',
  'AreaCurrentPercent',
  'AreaCurrent',
  'PopulationCurrent',
  'PopulationCurrentPercent',
  'PercentChangeFromWAve',
  'AreaChangeFromWAve',
  'StatisticFormatID',
  'USDMLevelID',
  'USDMLevel',
  'AreaMiles',
  'MapDate',
];

/**
 * Parse the UNL statistics CSV into row objects. Pure.
 * Throws {status:502} on bad shape (never returns fabricated rows).
 */
export function parseUsdmCsv(text) {
  const fail = (msg) =>
    Object.assign(new Error(`usdm_invalid_csv: ${msg}`), { status: 502 });
  if (typeof text !== 'string' || !text.trim()) throw fail('empty body');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) throw fail('no data rows');
  const header = parseCsvLine(lines[0]).map((h) => h.trim());
  for (let i = 0; i < HEADER.length; i++) {
    if (header[i] !== HEADER[i])
      throw fail(`unexpected header col ${i}: ${header[i]}`);
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    if (f.length < HEADER.length) continue; // ragged line — skip, counted
    const level = (f[9] ?? '').trim().toUpperCase();
    rows.push({
      aoi: (f[0] ?? '').trim() || null,
      areaPercent: numOrNull(f[1]),
      areaSqMi: parseLocaleNum(f[2]),
      population: parseLocaleNum(f[3]),
      populationPercent: numOrNull(f[4]),
      level,
      levelId: numOrNull(f[8]),
      mapDate: /^\d{4}-\d{2}-\d{2}$/.test((f[11] ?? '').trim())
        ? f[11].trim()
        : null,
    });
  }
  const dated = rows.filter((r) => r.mapDate && LEVELS.includes(r.level));
  if (!dated.length) throw fail('no dated D1–D4 rows');
  return dated;
}

/** Group rows by MapDate, newest first; take up to `weeks` weeks. Pure. */
export function selectWeeks(rows, weeks) {
  const byDate = new Map();
  for (const r of rows) {
    if (!byDate.has(r.mapDate)) byDate.set(r.mapDate, []);
    byDate.get(r.mapDate).push(r);
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, weeks);
  return dates.map((d) => ({
    mapDate: d,
    categories: LEVELS.map(
      (lvl) => byDate.get(d).find((r) => r.level === lvl) ?? null,
    ).filter(Boolean),
  }));
}

/**
 * Build the published payload from parsed rows. Pure.
 * weekOverWeek deltas are provider-computed from consecutive weekly rows
 * (percentage points), explicitly labeled — the upstream change columns
 * read 0.00 in this query mode and are ignored.
 */
export function buildUsdmPayload(parsed, { nowMs, query }) {
  const fail = (msg, status = 502) =>
    Object.assign(new Error(`usdm_${msg}`), { status });
  const weekGroups = selectWeeks(parsed, query.weeks);
  if (!weekGroups.length) throw fail('no_weeks');
  const latest = weekGroups[0];
  const prev = weekGroups[1] ?? null;
  if (!latest.categories.length) throw fail('no_categories');

  const categories = latest.categories.map((c) => {
    const p = prev?.categories.find((x) => x.level === c.level) ?? null;
    return {
      level: c.level,
      // Cumulative: share of the US in this category OR WORSE.
      areaPercent: c.areaPercent,
      areaSqMi: c.areaSqMi,
      population: c.population,
      populationPercent: c.populationPercent,
      wowDeltaPctPoints:
        c.areaPercent != null && p?.areaPercent != null
          ? Math.round((c.areaPercent - p.areaPercent) * 100) / 100
          : null,
    };
  });

  const byLevel = Object.fromEntries(categories.map((c) => [c.level, c]));
  const d1 = byLevel.D1 ?? {};
  const d3 = byLevel.D3 ?? {};
  const worst =
    [...categories].reverse().find((c) => (c.areaPercent ?? 0) > 0) ?? null;
  const mapMs = Date.parse(`${latest.mapDate}T12:00:00Z`);
  const mapAgeDays = Number.isFinite(mapMs)
    ? Math.max(0, (nowMs - mapMs) / 86_400_000)
    : null;

  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale: false,
    mapDate: latest.mapDate,
    mapAgeDays: mapAgeDays == null ? null : Math.round(mapAgeDays * 10) / 10,
    weeks: weekGroups.length,
    previousMapDate: prev?.mapDate ?? null,
    categories,
    summary: {
      d1PlusAreaPercent: d1.areaPercent ?? null,
      d3PlusAreaPercent: d3.areaPercent ?? null,
      populationInDrought: d1.population ?? null,
      worstLevel: worst?.level ?? null,
      worstAreaPercent: worst?.areaPercent ?? null,
    },
    attribution:
      'U.S. Drought Monitor (UNL / NOAA / USDA) — usdmdataservices.unl.edu documented REST',
    honesty: {
      cadence: 'weekly; maps dated Tuesdays, released Thursdays',
      cumulative:
        'category rows are cumulative: the D1 row is the share of the US in D1-or-worse drought, not the D1-only band',
      categoriesAvailable:
        'D1–D4 only — D0/None are not exposed by this UNL statistics variant and are never synthesized',
      scope:
        'national only — StateStatistics AOI queries returned empty during 2026-09-30 verification',
      deltas:
        'weekOverWeek wowDeltaPctPoints are provider-computed from consecutive weekly rows (percentage points)',
    },
  };
}

function fmtUsDate(ms) {
  const d = new Date(ms);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
}

function buildUsdmUrl(weeks, nowMs) {
  const endMs = nowMs;
  const startMs = nowMs - weeks * 7 * 86_400_000;
  const q = new URLSearchParams({
    aoi: 'TOTAL',
    dx: '1',
    DxLevelThresholdFrom: '0',
    DxLevelThresholdTo: '70',
    startdate: fmtUsDate(startMs),
    enddate: fmtUsDate(endMs),
    statisticsType: '1',
  });
  return `${API_BASE}?${q.toString()}`;
}

function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const weeksRaw = params.get('weeks');
  let weeks = DEFAULT_WEEKS;
  if (weeksRaw != null) {
    const n = Number(weeksRaw.trim());
    if (!Number.isInteger(n) || n < 1 || n > MAX_WEEKS)
      throw Object.assign(new Error(`usdm_bad_weeks: ${weeksRaw}`), {
        status: 400,
      });
    weeks = n;
  }
  return { weeks, key: `weeks=${weeks}` };
}

async function fetchUpstream(fetchImpl, weeks, nowMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(buildUsdmUrl(weeks, nowMs), {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv, text/plain' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`usdm_upstream_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    return parseUsdmCsv(text); // throws {status:502} on bad shape
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, body, cacheControl = 'public, max-age=21600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

async function getDoc(fetchImpl, weeks, nowMs, signal) {
  const key = `weeks=${weeks}`;
  if (docCache && docCache.key === key && nowMs - docCache.at < CACHE_TTL_MS)
    return docCache.parsed;
  signal?.throwIfAborted?.();
  if (!docInflight) {
    // Retry gate fires only after a FAILED doc fetch.
    if (nowMs - docFailedAt < RETRY_COOLDOWN_MS)
      throw new Error('usdm_retry_later');
    docInflight = fetchUpstream(fetchImpl, weeks, nowMs)
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
    const parsed = await getDoc(fetchImpl, query.weeks, nowMs, signal);
    const payload = buildUsdmPayload(parsed, { nowMs, query });
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

export function usdmProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
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
          { error: 'usdm_bad_request', detail: error.message },
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
          { error: 'usdm_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'usdm',
    configureServer({ middlewares }) {
      middlewares.use('/api/usdm', handler);
    },
  };
}

/** Test-only: reset module caches between tests. */
export function clearUsdmCaches() {
  docCache = null;
  docInflight = null;
  docFailedAt = -Infinity;
  payloadCache.clear();
}
