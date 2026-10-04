/**
 * Wave 9 (R2-10) — USACE reservoir levels provider
 * (CWMS Data API, keyless, Missouri River mainstem).
 *
 * Backlog R2-10 ("USACE reservoir levels"): "https://water.usace.army.mil
 * free. Zero in tree — rivers are half the water story." The public CWMS
 * Data API (CDA) at https://cwms-data.usace.army.mil/cwms-data/ serves
 * keyless, unauthenticated reads (auth gates write access only — confirmed
 * by the project's own docs and observed live 2026-10-01: no 401/403 on
 * any read). Discovery path used here:
 *   /locations?office=NWDM&names=FTPK
 *   /catalog/timeseries?office=NWDM&like=FTPK.*Stor.*
 *   /catalog/timeseries?office=NWDM&like=*Stor*        (office-wide roster)
 *   /timeseries?office=NWDM&name=<ts>&begin=..&end=..&unit=EN
 * Series names are pinned below (discovered live 2026-10-01); refresh
 * never re-discovers, so the default path costs exactly 2 subrequests
 * per reservoir (storage + pool elevation), 12 total — far under the
 * Cloudflare Workers 50-subrequest cap.
 *
 * Pinned roster (6): the complete Missouri River mainstem reservoir
 * system, Omaha District (NWDM). Live location metadata:
 *   FTPK Fort Peck Dam & Reservoir        MT (48.001, -106.418)
 *   GARR Garrison Dam & Reservoir         ND (47.505, -101.432)
 *   OAHE Oahe Dam & Reservoir             SD (44.450, -100.405)
 *   BEND Big Bend Dam & Reservoir         SD (44.041,  -99.445)
 *   FTRA Fort Randall Dam & Reservoir     SD (43.067,  -98.553)
 *   GAPT Gavins Point Dam & Reservoir     SD (42.850,  -97.483)
 * (County served as "Unknown" for SD stations upstream — dropped, not guessed.)
 *
 * Observed live 2026-10-01 from the build VM:
 *   storage  {ID}.Stor.Inst.~1Day.0.Best-MRBWM — daily, unit m3 (EN: ac-ft)
 *            latest 2026-10-01T05:00Z all six (FTPK 12,475,000 ac-ft ...)
 *   elevation {ID}.Elev.Inst.1Hour.0.Best-MRBWM — hourly, unit m (EN: ft)
 *            latest 2026-10-01T18:00Z FTPK 2222.17 ft (1.7h old)
 * Catalog extents can lag the series itself (FTPK catalog said latest
 * 2026-09-13 while /timeseries served 2026-10-01) — the payload trusts
 * only the series bytes, and every row carries its own timestamp + age.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Routes:
 *   GET /api/usace                  → all 6 reservoirs (≤12 subrequests)
 *   GET /api/usace?reservoir=FTPK   → one reservoir (2 subrequests)
 *   ?reservoir=<unknown-but-wellformed> → 200 {requestedNotFound:true}
 *     (nexrad/goes/pollen/hab pattern)
 *   bad reservoir id → 400
 *
 * 6h TTL (daily storage cadence) + 7d key-scoped stale fallback;
 * per-reservoir fail-soft (all dark → honest 502).
 */

const CDA_BASE = 'https://cwms-data.usace.army.mil/cwms-data';
const OFFICE = 'NWDM';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 128 * 1024; // observed ≤ ~5 KB per series; generous headroom
const CACHE_TTL_MS = 6 * 3600_000; // daily storage cadence
const STALE_MS = 7 * 24 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const STORAGE_WINDOW_DAYS = 4; // daily series: expect ~4 rows, take latest
const ELEV_WINDOW_DAYS = 2; // hourly series: expect ~48 rows, take latest
const STORAGE_FRESH_DAYS = 7;
const ELEV_FRESH_DAYS = 2;
const USER_AGENT = 'satwq-reality-os/1.0 (gods-eye-view; usace layer; keyless)';

/** Pinned Missouri mainstem reservoirs — series names verified live 2026-10-01. */
export const RESERVOIRS = [
  {
    id: 'ftpk',
    code: 'FTPK',
    name: 'Fort Peck Dam & Reservoir',
    state: 'MT',
    lat: 48.001,
    lon: -106.418,
    storageSeries: 'FTPK.Stor.Inst.~1Day.0.Best-MRBWM',
    elevSeries: 'FTPK.Elev.Inst.1Hour.0.Best-MRBWM',
  },
  {
    id: 'garr',
    code: 'GARR',
    name: 'Garrison Dam & Reservoir',
    state: 'ND',
    lat: 47.505,
    lon: -101.432,
    storageSeries: 'GARR.Stor.Inst.~1Day.0.Best-MRBWM',
    elevSeries: 'GARR.Elev.Inst.1Hour.0.Best-MRBWM',
  },
  {
    id: 'oahe',
    code: 'OAHE',
    name: 'Oahe Dam & Reservoir',
    state: 'SD',
    lat: 44.45,
    lon: -100.405,
    storageSeries: 'OAHE.Stor.Inst.~1Day.0.Best-MRBWM',
    elevSeries: 'OAHE.Elev.Inst.1Hour.0.Best-MRBWM',
  },
  {
    id: 'bend',
    code: 'BEND',
    name: 'Big Bend Dam & Reservoir',
    state: 'SD',
    lat: 44.041,
    lon: -99.445,
    storageSeries: 'BEND.Stor.Inst.~1Day.0.Best-MRBWM',
    elevSeries: 'BEND.Elev.Inst.1Hour.0.Best-MRBWM',
  },
  {
    id: 'ftra',
    code: 'FTRA',
    name: 'Fort Randall Dam & Reservoir',
    state: 'SD',
    lat: 43.067,
    lon: -98.553,
    storageSeries: 'FTRA.Stor.Inst.~1Day.0.Best-MRBWM',
    elevSeries: 'FTRA.Elev.Inst.1Hour.0.Best-MRBWM',
  },
  {
    id: 'gapt',
    code: 'GAPT',
    name: 'Gavins Point Dam & Reservoir',
    state: 'SD',
    lat: 42.85,
    lon: -97.483,
    storageSeries: 'GAPT.Stor.Inst.~1Day.0.Best-MRBWM',
    elevSeries: 'GAPT.Elev.Inst.1Hour.0.Best-MRBWM',
  },
];

/** Number(null)===0 guard: null/NaN/empty upstream numerics become null, never 0. */
export function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const RESERVOIR_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Validate the query. Returns {mode:'all'|'reservoir'|'notfound', reservoir?}.
 * Throws {status:400} on malformed input; unknown-but-wellformed ids
 * return {mode:'notfound'} (200 + requestedNotFound). Pure, for tests.
 */
export function parseQuery(query) {
  const raw = query.get('reservoir');
  if (raw != null && raw !== '') {
    if (!RESERVOIR_ID_RE.test(raw))
      throw Object.assign(new Error('usace_bad_reservoir'), { status: 400 });
    const found = RESERVOIRS.find((r) => r.id === raw);
    if (!found) return { mode: 'notfound', reservoir: raw };
    return { mode: 'reservoir', reservoir: found };
  }
  return { mode: 'all' };
}

export function selectionReservoirs(sel) {
  if (sel.mode === 'reservoir') return [sel.reservoir];
  return RESERVOIRS;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

export function buildStorageUrl(reservoir) {
  const p = new URLSearchParams({
    office: OFFICE,
    name: reservoir.storageSeries,
    begin: isoDaysAgo(STORAGE_WINDOW_DAYS),
    end: new Date().toISOString(),
    unit: 'EN', // ac-ft for storage
    trim: 'true',
    'page-size': '16',
  });
  return `${CDA_BASE}/timeseries?${p.toString()}`;
}

export function buildElevUrl(reservoir) {
  const p = new URLSearchParams({
    office: OFFICE,
    name: reservoir.elevSeries,
    begin: isoDaysAgo(ELEV_WINDOW_DAYS),
    end: new Date().toISOString(),
    unit: 'EN', // ft for elevation
    trim: 'true',
    'page-size': '120',
  });
  return `${CDA_BASE}/timeseries?${p.toString()}`;
}

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`usace_upstream_${response.status}`), {
        status: 502,
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('usace_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error('usace_upstream_bad_json'), {
        status: 502,
      });
    throw Object.assign(
      new Error(`usace_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Extract the latest observed value from a CDA /timeseries envelope.
 * Returns {timeMs, value, quality, units} or null when no usable rows.
 * Rows are [time_ms, value, quality]; nulls are skipped (never zero-filled).
 * Pure, exported for tests.
 */
export function latestValue(envelope) {
  const values = envelope?.values;
  if (!Array.isArray(values) || values.length === 0) return null;
  for (let i = values.length - 1; i >= 0; i--) {
    const row = values[i];
    if (!Array.isArray(row) || row.length < 2) continue;
    const timeMs = numOrNull(row[0]);
    const value = numOrNull(row[1]);
    if (timeMs == null || value == null) continue;
    return {
      timeMs,
      value,
      quality: numOrNull(row[2]),
      units: envelope?.units ?? null,
    };
  }
  return null;
}

/**
 * Parse one reservoir's storage + elevation envelopes into a row.
 * Throws {status:502} when neither series yields a value (never fabricates).
 * Pure, exported for tests.
 */
export function parseReservoirPayload(
  reservoir,
  storageEnv,
  elevEnv,
  nowMs = Date.now(),
) {
  const fail = (msg) =>
    Object.assign(new Error(`usace_invalid_payload: ${msg}`), { status: 502 });
  const stor = latestValue(storageEnv);
  const elev = latestValue(elevEnv);
  if (!stor && !elev) throw fail('no usable values in either series');

  const ageDays = (timeMs) => {
    if (timeMs == null) return null;
    const age = (nowMs - timeMs) / 86_400_000;
    return age < 0 ? 0 : Math.round(age * 10) / 10;
  };

  const storAge = stor ? ageDays(stor.timeMs) : null;
  const elevAge = elev ? ageDays(elev.timeMs) : null;

  return {
    id: reservoir.id,
    code: reservoir.code,
    name: reservoir.name,
    state: reservoir.state,
    lat: reservoir.lat,
    lon: reservoir.lon,
    ok: true,
    storage: stor
      ? {
          acFt: stor.value,
          time: new Date(stor.timeMs).toISOString(),
          ageDays: storAge,
          fresh: storAge != null && storAge <= STORAGE_FRESH_DAYS,
          quality: stor.quality,
          units: 'ac-ft',
        }
      : null,
    poolElevation: elev
      ? {
          ft: elev.value,
          time: new Date(elev.timeMs).toISOString(),
          ageDays: elevAge,
          fresh: elevAge != null && elevAge <= ELEV_FRESH_DAYS,
          quality: elev.quality,
          units: 'ft',
        }
      : null,
    office: OFFICE,
  };
}

/** Build the full payload envelope. Pure apart from generatedAt. */
export function buildPayload(rows, stale) {
  const ok = rows.filter((r) => r.ok);
  return {
    generatedAt: new Date().toISOString(),
    stale: Boolean(stale),
    source:
      'USACE CWMS Data API (Missouri River Basin, Omaha District NWDM) — keyless reads',
    attribution:
      'Data: U.S. Army Corps of Engineers, CWMS Data API (cwms-data.usace.army.mil), public keyless reads.',
    units: { storage: 'ac-ft', poolElevation: 'ft' },
    summary: {
      total: rows.length,
      ok: ok.length,
      dark: rows.length - ok.length,
      fresh: ok.filter(
        (r) => (r.storage?.fresh ?? false) && (r.poolElevation?.fresh ?? false),
      ).length,
    },
    reservoirs: rows,
    honesty: {
      observed:
        'Storage (daily) and pool elevation (hourly) are the latest OBSERVED series values from the district water-control system — no forecasts, no model, no interpolation.',
      catalogLag:
        'CDA catalog extents can lag the series itself (observed 2026-10-01: catalog said 2026-09-13 while /timeseries served 2026-10-01); every row carries its own timestamp and age, and ages are the authority.',
      noCapacity:
        'Upstream location records carry no capacity fields, so no %full is computed — a fabricated denominator is worse than an absent one.',
      quality:
        'Upstream quality codes are surfaced raw and never used to zero-fill or gate values.',
    },
  };
}

// --- caches (per query key, mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;
const PAYLOAD_CACHE_MAX = 16;

function queryKey(sel) {
  if (sel.mode === 'reservoir') return `reservoir:${sel.reservoir.id}`;
  return 'all';
}

async function fetchOne(reservoir) {
  try {
    const [storageEnv, elevEnv] = await Promise.all([
      fetchJsonCapped(buildStorageUrl(reservoir)),
      fetchJsonCapped(buildElevUrl(reservoir)),
    ]);
    return parseReservoirPayload(reservoir, storageEnv, elevEnv);
  } catch (error) {
    return {
      id: reservoir.id,
      code: reservoir.code,
      name: reservoir.name,
      state: reservoir.state,
      lat: reservoir.lat,
      lon: reservoir.lon,
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
      const reservoirs = selectionReservoirs(sel);
      const rows = await Promise.all(reservoirs.map((r) => fetchOne(r)));
      const okRows = rows.filter((r) => r.ok);
      if (okRows.length === 0) {
        docFailedAt = Date.now();
        if (hit && now - hit.at < STALE_MS)
          return { payload: hit.payload, stale: true };
        throw Object.assign(new Error('usace_all_upstreams_failed'), {
          status: 502,
        });
      }
      const payload = buildPayload(rows, false);
      if (payloadCache.size >= PAYLOAD_CACHE_MAX)
        payloadCache.delete(payloadCache.keys().next().value);
      payloadCache.set(key, { at: Date.now(), payload });
      return { payload, stale: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=21600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 USACE reservoir proxy. */
export function usaceProxy() {
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
          reservoir: sel.reservoir,
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
          error: 'usace_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'usace',
    configureServer({ middlewares }) {
      middlewares.use('/api/usace', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/usace', handler);
    },
  };
}

export const _usaceInternals = {
  parseQuery,
  latestValue,
  parseReservoirPayload,
  buildPayload,
  buildStorageUrl,
  buildElevUrl,
  selectionReservoirs,
  clearCaches: () => {
    payloadCache.clear();
    inflight.clear();
    docFailedAt = -Infinity;
  },
};
