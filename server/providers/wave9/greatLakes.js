/**
 * Wave 9 (R2-11) — Great Lakes water levels provider
 * (Coordinating Committee lake-wide monthly means via Zenodo, keyless).
 *
 * Backlog R2-11 ("Great Lakes levels"): "NOAA GLERL free. Zero in tree."
 * tides.js holds 42 CO-OPS coastal stations but zero Great Lakes stations;
 * this is the lake-wide coordinated record GLERL's own dashboard visualizes.
 *
 * Upstream (verified live 2026-10-01 from the build VM):
 *   Record API (concept recid — stable, always resolves to latest version):
 *     https://zenodo.org/api/records/14182902
 *     (concept DOI 10.5281/zenodo.14182902; resolved 2026-10-01 to
 *      version doi 10.5281/zenodo.21908489, updated 2026-08-12)
 *   → files[] → 5 CSVs Monthly_mean_water_levels_Lake_<Lake>_1918-YYYY.csv
 *   → each file's links.self IS the /content download URL (verified: no -L
 *     needed on /content; the record API itself 302s concept→version, so
 *     redirect:'follow' is required and supported).
 *
 * CSV shape (real bytes, Lake Superior 2026-10-01):
 *   # global_attributes:* comment lines (incl. gauge network + IGLD 1985
 *   datum) … blank ',,,' lines … header
 *   time,time_bnds_start,time_bnds_end,monthly_lakewide_average_water_level
 *   1/1/1918,1/1/1918,1/31/1918,183.25
 *   …
 *   12/1/2025,12/1/2025,12/31/2025,183.27   (latest, 2025-12)
 *
 * Gauge networks (from each CSV's global_attributes:comment — pinned, not guessed):
 *   Superior       — NOAA: Duluth MN, Marquette G.C. MI, Point Iroquois MI;
 *                    CHS: Thunder Bay, Michipicoten
 *   Michigan-Huron — NOAA: Harbor Beach MI, Mackinaw City MI, Ludington MI,
 *                    Milwaukee WI; CHS: Thessalon, Tobermory
 *   St. Clair      — NOAA: St. Clair Shores MI; CHS: Belle River ON
 *   Erie           — NOAA: Cleveland OH, Toledo OH; CHS: Port Colborne, Port Stanley
 *   Ontario        — NOAA: Rochester NY, Oswego NY;
 *                    CHS: Toronto, Kingston, Cobourg, Port Weller
 *
 * Routes:
 *   GET /api/great-lakes            → all 5 lakes (≤6 subrequests)
 *   GET /api/great-lakes?lake=erie  → one lake (2 subrequests)
 *   ?lake=<unknown-but-wellformed> → 200 {requestedNotFound:true}
 *     (nexrad/goes/pollen/hab/usace pattern)
 *   bad lake id → 400
 *
 * 24h TTL (upstream updates ~annually) + 90d key-scoped stale fallback;
 * per-lake fail-soft (all dark → honest 502).
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

const RECORD_API_URL = 'https://zenodo.org/api/records/14182902';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 256 * 1024; // observed ~50 KB per CSV; generous headroom
const RECORD_BODY_CAP_BYTES = 64 * 1024; // record API JSON is small
const CACHE_TTL_MS = 24 * 3600_000; // upstream updates ~annually
const STALE_MS = 90 * 24 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const FRESH_LAG_MONTHS = 14; // annual update cadence: latest month must be ≤14 mo old
const M_TO_FT = 3.28084;
const USER_AGENT =
  'satwq-reality-os/1.0 (gods-eye-view; great-lakes layer; keyless)';

/** Pinned lake roster — file-key fragment + gauge network from live CSV metadata. */
export const LAKES = [
  {
    id: 'superior',
    key: 'Superior',
    name: 'Lake Superior',
    noaaGauges: ['Duluth MN', 'Marquette G.C. MI', 'Point Iroquois MI'],
    chsGauges: ['Thunder Bay', 'Michipicoten'],
  },
  {
    id: 'michigan-huron',
    key: 'Michigan-Huron',
    name: 'Lakes Michigan–Huron',
    noaaGauges: [
      'Harbor Beach MI',
      'Mackinaw City MI',
      'Ludington MI',
      'Milwaukee WI',
    ],
    chsGauges: ['Thessalon', 'Tobermory'],
  },
  {
    id: 'stclair',
    key: 'StClair',
    name: 'Lake St. Clair',
    noaaGauges: ['St. Clair Shores MI'],
    chsGauges: ['Belle River ON'],
  },
  {
    id: 'erie',
    key: 'Erie',
    name: 'Lake Erie',
    noaaGauges: ['Cleveland OH', 'Toledo OH'],
    chsGauges: ['Port Colborne', 'Port Stanley'],
  },
  {
    id: 'ontario',
    key: 'Ontario',
    name: 'Lake Ontario',
    noaaGauges: ['Rochester NY', 'Oswego NY'],
    chsGauges: ['Toronto', 'Kingston', 'Cobourg', 'Port Weller'],
  },
];

/** Number(null)===0 guard: null/NaN/empty upstream numerics become null, never 0. */
export function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const LAKE_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Validate the query. Returns {mode:'all'|'lake'|'notfound', lake?}.
 * Throws {status:400} on malformed input; unknown-but-wellformed ids
 * return {mode:'notfound'} (200 + requestedNotFound). Pure, for tests.
 */
export function parseQuery(query) {
  const raw = query.get('lake');
  if (raw != null && raw !== '') {
    if (!LAKE_ID_RE.test(raw))
      throw Object.assign(new Error('greatlakes_bad_lake'), { status: 400 });
    const found = LAKES.find((l) => l.id === raw);
    if (!found) return { mode: 'notfound', lake: raw };
    return { mode: 'lake', lake: found };
  }
  return { mode: 'all' };
}

export function selectionLakes(sel) {
  if (sel.mode === 'lake') return [sel.lake];
  return LAKES;
}

async function fetchTextCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). The Zenodo concept
      // record 302s concept→version, so 'follow' is functionally required.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`greatlakes_upstream_${response.status}`), {
        status: 502,
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('greatlakes_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(
      new Error(`greatlakes_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Parse the Zenodo record API JSON into [{lake, contentUrl}].
 * Matches CSV file keys like Monthly_mean_water_levels_Lake_Superior_1918-2025.csv.
 * Throws {status:502} when the shape is unusable. Pure, exported for tests.
 */
export function parseRecordApi(recordJson) {
  const fail = (msg) =>
    Object.assign(new Error(`greatlakes_invalid_record: ${msg}`), {
      status: 502,
    });
  const files = recordJson?.files;
  if (!Array.isArray(files) || files.length === 0) throw fail('no files array');
  const out = [];
  for (const lake of LAKES) {
    const match = files.find(
      (f) =>
        typeof f?.key === 'string' &&
        new RegExp(
          `^Monthly_mean_water_levels_Lake_${lake.key}_1918-\\d{4}\\.csv$`,
        ).test(f.key) &&
        typeof f?.links?.self === 'string',
    );
    if (!match) throw fail(`missing CSV for lake ${lake.id}`);
    out.push({ lake, contentUrl: match.links.self });
  }
  return out;
}

/**
 * Parse one lake's CSV bytes into {months:[{month:'YYYY-MM', levelM}]}.
 * Skips # comment lines and blank ',,,' lines; header row is
 * time,time_bnds_start,time_bnds_end,monthly_lakewide_average_water_level.
 * Nulls are skipped (never zero-filled). Pure, exported for tests.
 */
export function parseLakeCsv(text) {
  const months = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cells = line.split(',');
    if (cells.length < 4) continue;
    if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(cells[0])) continue; // header + stray ',,,' lines
    const levelM = numOrNull(cells[3]);
    if (levelM == null) continue;
    const [m, , y] = cells[0].split('/');
    months.push({
      month: `${y}-${String(Number(m)).padStart(2, '0')}`,
      levelM,
    });
  }
  return months;
}

/** Months between 'YYYY-MM' and now (fractional, signed). Pure. */
export function monthsSince(yyyyMm, nowMs = Date.now()) {
  const [y, m] = yyyyMm.split('-').map(Number);
  const now = new Date(nowMs);
  return (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
}

/**
 * Build one lake's row from parsed months. Pure apart from freshness
 * which takes nowMs. Record high/low + full-record mean are descriptive,
 * never predictive.
 */
export function buildLakeRow(lake, months, nowMs = Date.now()) {
  if (!Array.isArray(months) || months.length === 0)
    throw Object.assign(
      new Error('greatlakes_invalid_payload: no usable rows'),
      { status: 502 },
    );
  const latest = months[months.length - 1];
  const sum = months.reduce((a, r) => a + r.levelM, 0);
  const meanM = sum / months.length;
  let hi = months[0];
  let lo = months[0];
  for (const r of months) {
    if (r.levelM > hi.levelM) hi = r;
    if (r.levelM < lo.levelM) lo = r;
  }
  const lagMonths = monthsSince(latest.month, nowMs);
  const ft = (v) => Math.round(v * M_TO_FT * 100) / 100;
  return {
    id: lake.id,
    key: lake.key,
    name: lake.name,
    ok: true,
    datum: 'IGLD 1985',
    gauges: { noaa: lake.noaaGauges, chs: lake.chsGauges },
    months: months.length,
    latest: {
      month: latest.month,
      levelM: latest.levelM,
      levelFt: ft(latest.levelM),
      lagMonths,
    },
    mean: { levelM: Math.round(meanM * 1000) / 1000, levelFt: ft(meanM) },
    anomaly: {
      levelM: Math.round((latest.levelM - meanM) * 1000) / 1000,
      levelFt: ft(latest.levelM - meanM),
      vs: `full-record mean ${months[0].month}–${latest.month}`,
    },
    recordHigh: { month: hi.month, levelM: hi.levelM, levelFt: ft(hi.levelM) },
    recordLow: { month: lo.month, levelM: lo.levelM, levelFt: ft(lo.levelM) },
    recent: months
      .slice(-12)
      .map((r) => ({ month: r.month, levelM: r.levelM })),
    fresh: lagMonths <= FRESH_LAG_MONTHS,
  };
}

/** Build the full payload envelope. Pure apart from generatedAt. */
export function buildPayload(rows, recordDoi, stale) {
  const ok = rows.filter((r) => r.ok);
  return {
    generatedAt: new Date().toISOString(),
    stale: Boolean(stale),
    source:
      'Coordinating Committee on Great Lakes Basic Hydraulic and Hydrologic Data — lake-wide average monthly mean water levels, via Zenodo (keyless, concept DOI always latest version)',
    attribution:
      'Data: The Coordinating Committee on Great Lakes Basic Hydraulic and Hydrologic Data (ECCC + USACE, from CHS + NOAA gauge observations), via Zenodo.',
    recordDoi,
    units: { level: 'm (native, IGLD 1985); ft converted ×3.28084' },
    summary: {
      total: rows.length,
      ok: ok.length,
      dark: rows.length - ok.length,
      fresh: ok.filter((r) => r.fresh).length,
    },
    lakes: rows,
    honesty: {
      monthlyMeans:
        'Each value is the lake-wide AVERAGE monthly mean: daily lake-wide means (mean of the coordinated US+Canadian gauge network around each lake, subset when a gauge is dark) averaged over the month — not a single gauge reading, not real-time.',
      michiganHuron:
        'Lakes Michigan and Huron are one hydrologic unit (same surface elevation) and are published as a single coordinated series — this is upstream convention, not a merge on our side.',
      updateLag:
        'The Zenodo record is updated ~annually (the 2026-08-12 version carries data through 2025-12); the latest month therefore trails real time by up to ~14 months. "fresh" means the latest month is within that annual cadence window.',
      datum:
        'Levels are meters above IGLD 1985; feet are converted ×3.28084 and rounded to 2 dp.',
      anomaly:
        'Anomaly = latest month minus the full-record mean (1918–latest); a descriptive anomaly, never a forecast.',
    },
  };
}

// --- caches (per query key, mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;
const PAYLOAD_CACHE_MAX = 16;

function queryKey(sel) {
  if (sel.mode === 'lake') return `lake:${sel.lake.id}`;
  return 'all';
}

async function fetchRecordApi() {
  const text = await fetchTextCapped(RECORD_API_URL, RECORD_BODY_CAP_BYTES);
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('greatlakes_upstream_bad_json'), {
      status: 502,
    });
  }
  return { recordDoi: json?.doi ?? null, files: parseRecordApi(json) };
}

async function fetchOneLake(entry) {
  try {
    const text = await fetchTextCapped(entry.contentUrl, BODY_CAP_BYTES);
    const months = parseLakeCsv(text);
    return buildLakeRow(entry.lake, months);
  } catch (error) {
    return {
      id: entry.lake.id,
      key: entry.lake.key,
      name: entry.lake.name,
      ok: false,
      error: error?.message ?? 'unknown',
      status: error?.status ?? 502,
    };
  }
}

async function getPayload(sel) {
  const key = queryKey(sel);
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS)
    return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    if (
      now - docFailedAt < RETRY_COOLDOWN_MS &&
      hit &&
      now - hit.at < STALE_MS
    ) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      const { recordDoi, files } = await fetchRecordApi();
      const wanted = new Set(selectionLakes(sel).map((l) => l.id));
      const rows = await Promise.all(
        files.filter((f) => wanted.has(f.lake.id)).map(fetchOneLake),
      );
      const okRows = rows.filter((r) => r.ok);
      if (okRows.length === 0) {
        docFailedAt = Date.now();
        if (hit && now - hit.at < STALE_MS)
          return { payload: hit.payload, stale: true };
        throw Object.assign(new Error('greatlakes_all_upstreams_failed'), {
          status: 502,
        });
      }
      const payload = buildPayload(rows, recordDoi, false);
      if (payloadCache.size >= PAYLOAD_CACHE_MAX)
        payloadCache.delete(payloadCache.keys().next().value);
      payloadCache.set(key, { at: Date.now(), payload });
      return { payload, stale: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=86400') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 Great Lakes water-level proxy. */
export function greatLakesProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let sel;
    try {
      sel = parseQuery(new URL(req.url, 'http://localhost').searchParams);
    } catch (error) {
      return sendJson(
        res,
        error.status ?? 400,
        { error: error.message },
        'no-store',
      );
    }
    if (sel.mode === 'notfound') {
      return sendJson(
        res,
        200,
        {
          generatedAt: new Date().toISOString(),
          requestedNotFound: true,
          lake: sel.lake,
        },
        'no-store',
      );
    }
    try {
      const { payload, stale } = await getPayload(sel);
      sendJson(res, 200, stale ? { ...payload, stale: true } : payload);
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'greatlakes_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'great-lakes',
    configureServer({ middlewares }) {
      middlewares.use('/api/great-lakes', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/great-lakes', handler);
    },
  };
}

export const _greatLakesInternals = {
  parseQuery,
  parseRecordApi,
  parseLakeCsv,
  monthsSince,
  buildLakeRow,
  buildPayload,
  selectionLakes,
  RECORD_API_URL,
  clearCaches: () => {
    payloadCache.clear();
    inflight.clear();
    docFailedAt = -Infinity;
  },
};
