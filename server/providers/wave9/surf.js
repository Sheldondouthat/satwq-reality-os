/**
 * Wave 9 — Surf & sea state (NWS gridded wave forecast).
 *
 * Upstream: https://api.weather.gov/gridpoints/{WFO}/{x},{y} (keyless JSON;
 * requires a User-Agent header). Grids were resolved from offshore surf
 * points via /points/{lat},{lon} and LIVE-VERIFIED 2026-10-02: all 8 grids
 * carry waveHeight/wavePeriod/waveDirection/wavePeriod2/windWaveHeight.
 *
 * R2-16 origin note: the round-2 premise ("NOAA NOMADS, surf/sea-state")
 * resolved to NOMADS' retired OpenDAP service — nomads.ncep.noaa.gov/dods/*
 * now answers "OpenDAP format has been retired" (SCN 25-81). The NWS
 * gridded wave fields below are the keyless JSON answer for the same
 * surf/sea-state use case (WaveWatch-III-derived model output).
 *
 * HONESTY: these are FORECAST model values (NWS gridded, WaveWatch-III
 * derived), not buoy/radar observations. A waveHeight of 0.0 is the model's
 * forecast — carried verbatim, never replaced with null. Missing fields or
 * empty value arrays read null, never synthesized. updateTime is the
 * upstream model-cycle stamp. Data: National Weather Service.
 */
const UPSTREAM_BASE = 'https://api.weather.gov/gridpoints';
const USER_AGENT = 'satwq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const BODY_CAP_BYTES = 4_000_000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // model data: 6h refresh
const STALE_MS = 7 * 24 * 3600 * 1000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const CACHE_CONTROL = 'public, max-age=21600';

// Pinned surf spots — grids resolved + wave-fields verified live 2026-10-02.
const SPOTS = [
  {
    id: 'pipeline',
    name: 'Pipeline, Oahu HI',
    lat: 21.664,
    lon: -158.053,
    wfo: 'HFO',
    x: 146,
    y: 161,
    coast: 'Hawaii',
  },
  {
    id: 'trestles',
    name: 'Trestles, San Clemente CA',
    lat: 33.384,
    lon: -117.593,
    wfo: 'SGX',
    x: 46,
    y: 46,
    coast: 'SoCal',
  },
  {
    id: 'oceanbeach',
    name: 'Ocean Beach, San Francisco CA',
    lat: 37.755,
    lon: -122.51,
    wfo: 'MTR',
    x: 81,
    y: 105,
    coast: 'NorCal',
  },
  {
    id: 'santacruz',
    name: 'Santa Cruz CA',
    lat: 36.951,
    lon: -122.026,
    wfo: 'MTR',
    x: 91,
    y: 66,
    coast: 'NorCal',
  },
  {
    id: 'cocoabeach',
    name: 'Cocoa Beach FL',
    lat: 28.32,
    lon: -80.607,
    wfo: 'MLB',
    x: 57,
    y: 62,
    coast: 'Florida Atlantic',
  },
  {
    id: 'nagshead',
    name: 'Nags Head, Outer Banks NC',
    lat: 35.957,
    lon: -75.624,
    wfo: 'MHX',
    x: 91,
    y: 119,
    coast: 'Outer Banks',
  },
  {
    id: 'montauk',
    name: 'Montauk NY',
    lat: 41.048,
    lon: -71.949,
    wfo: 'OKX',
    x: 101,
    y: 69,
    coast: 'Long Island',
  },
  {
    id: 'rincon',
    name: 'Rincón PR',
    lat: 18.34,
    lon: -67.27,
    wfo: 'SJU',
    x: 64,
    y: 121,
    coast: 'Puerto Rico',
  },
];

const SPOT_BY_ID = new Map(SPOTS.map((s) => [s.id, s]));
const ID_RE = /^[a-z0-9-]{1,32}$/;

const M_TO_FT = 3.28084;
export { M_TO_FT };

function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty cell = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse an NWS validTime "start/PTnH" into { startMs, durMs }. Returns null
 * on malformed input — the row is skipped, never guessed.
 */
export function parseValidTime(vt) {
  if (typeof vt !== 'string') return null;
  const parts = vt.split('/');
  if (parts.length !== 2) return null;
  const startMs = Date.parse(parts[0]);
  if (!Number.isFinite(startMs)) return null;
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i.exec(parts[1]);
  if (!m) return null;
  const days = Number(m[1] || 0);
  const hours = Number(m[2] || 0);
  const mins = Number(m[3] || 0);
  const secs = Number(m[4] || 0);
  const durMs = (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000;
  return { startMs, durMs };
}

function fieldRows(props, key) {
  const field = props?.[key];
  const values = Array.isArray(field?.values) ? field.values : [];
  const rows = [];
  for (const v of values) {
    const vt = parseValidTime(v?.validTime);
    if (!vt) continue; // malformed row: skip, never guess
    rows.push({
      t: new Date(vt.startMs).toISOString(),
      startMs: vt.startMs,
      value: numOrNull(v?.value),
    });
  }
  return { uom: field?.uom ?? null, rows };
}

/**
 * Build one spot payload from a gridpoints properties object.
 * Fields entirely absent (or with zero parseable rows) read null.
 */
export function parseSpot(spot, props, nowMs) {
  const updateTime =
    typeof props?.updateTime === 'string' ? props.updateTime : null;
  const waveHeight = fieldRows(props, 'waveHeight');
  const wavePeriod = fieldRows(props, 'wavePeriod');
  const waveDirection = fieldRows(props, 'waveDirection');
  const wavePeriod2 = fieldRows(props, 'wavePeriod2');
  const windWaveHeight = fieldRows(props, 'windWaveHeight');

  const at = (rows) => (rows.length ? rows[0] : null);
  const val = (rows) => {
    const r = at(rows);
    return r ? r.value : null; // nulls preserved; real 0.0 preserved
  };

  const wh = waveHeight.rows;
  const horizonMs = nowMs + 24 * 3600 * 1000;
  let next24hMaxWaveHeightM = null;
  let next24hRows = 0;
  for (const r of wh) {
    if (r.startMs > horizonMs) break; // upstream rows are time-ascending
    next24hRows += 1;
    if (
      r.value != null &&
      (next24hMaxWaveHeightM == null || r.value > next24hMaxWaveHeightM)
    ) {
      next24hMaxWaveHeightM = r.value;
    }
  }

  const latest = {
    at: at(wh)?.t ?? at(wavePeriod.rows)?.t ?? null,
    waveHeightM: val(wh),
    wavePeriodS: val(wavePeriod.rows),
    waveDirectionDeg: val(waveDirection.rows),
    wavePeriod2S: val(wavePeriod2.rows),
    windWaveHeightM: val(windWaveHeight.rows),
  };

  // 10-row series aligned on the waveHeight times (period carried alongside).
  const series = wh.slice(0, 10).map((r, i) => ({
    t: r.t,
    waveHeightM: r.value,
    wavePeriodS: wavePeriod.rows[i] ? wavePeriod.rows[i].value : null,
  }));

  return {
    id: spot.id,
    name: spot.name,
    lat: spot.lat,
    lon: spot.lon,
    grid: `${spot.wfo}/${spot.x},${spot.y}`,
    coast: spot.coast,
    ok: true,
    updateTime,
    latest,
    next24hMaxWaveHeightM,
    next24hRows,
    series,
    fieldRows: {
      waveHeight: wh.length,
      wavePeriod: wavePeriod.rows.length,
      waveDirection: waveDirection.rows.length,
      wavePeriod2: wavePeriod2.rows.length,
      windWaveHeight: windWaveHeight.rows.length,
    },
  };
}

export function buildPayload(spots, stale) {
  const live = spots.filter((s) => s.ok);
  let maxWaveHeightM = null;
  let maxWaveSpotId = null;
  for (const s of live) {
    const v = s.next24hMaxWaveHeightM;
    if (v != null && (maxWaveHeightM == null || v > maxWaveHeightM)) {
      maxWaveHeightM = v;
      maxWaveSpotId = s.id;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    upstream: UPSTREAM_BASE,
    stale: !!stale,
    summary: {
      total: spots.length,
      ok: live.length,
      dark: spots.length - live.length,
      maxWaveHeightM,
      maxWaveSpotId,
    },
    spots,
    honesty: {
      forecastNotObserved:
        'NWS gridded wave forecast (WaveWatch-III-derived model output) — NOT buoy or radar observations. Quiet seas are real forecast values, not gaps.',
      units:
        'waveHeight/windWaveHeight in meters (SI, native NWS units); ticker shows feet (m × 3.28084). wavePeriod/wavePeriod2 in seconds; waveDirection in degrees.',
      zerosAreReal:
        'A waveHeight of 0.0 is the model forecast value — carried verbatim, never replaced with null.',
      nulls:
        'Missing fields or empty value arrays read null, never synthesized.',
      lag: 'Grids refresh on the NWS model cycle (~hourly); updateTime is the upstream stamp.',
      nomadsNote:
        'NOAA NOMADS OpenDAP/DODS was retired (SCN 25-81); the gridded NWS wave fields above are the keyless JSON path for surf/sea-state.',
      attribution: 'Data: National Weather Service (api.weather.gov).',
    },
  };
}

// --- fetch machinery (wave9 conventions) ---

async function fetchJsonCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge.
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/geo+json, application/json',
      },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`surf_upstream_${response.status}`), {
        status: 502,
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('surf_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(
      new Error(`surf_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

// --- caches (mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
const failedAt = new Map(); // key -> timestamp of last fetch failure

async function getPayload(spotFilter) {
  const key = spotFilter ? `spot:${spotFilter}` : 'all';
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS)
    return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    const lastFail = failedAt.get(key) ?? -Infinity;
    if (now - lastFail < RETRY_COOLDOWN_MS && hit && now - hit.at < STALE_MS) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const targets = spotFilter ? [SPOT_BY_ID.get(spotFilter)] : SPOTS;
        const nowMs = Date.now();
        const spots = [];
        for (const spot of targets) {
          try {
            const doc = await fetchJsonCapped(
              `${UPSTREAM_BASE}/${spot.wfo}/${spot.x},${spot.y}`,
              BODY_CAP_BYTES,
            );
            spots.push(parseSpot(spot, doc?.properties, nowMs));
          } catch (error) {
            // Per-spot fail-soft: one dark grid never 502s the route.
            spots.push({
              id: spot.id,
              name: spot.name,
              lat: spot.lat,
              lon: spot.lon,
              grid: `${spot.wfo}/${spot.x},${spot.y}`,
              coast: spot.coast,
              ok: false,
              reason: error?.message ?? 'fetch failed',
            });
          }
        }
        const live = spots.filter((s) => s.ok);
        if (live.length === 0) {
          throw Object.assign(new Error('surf_all_spots_dark'), {
            status: 502,
          });
        }
        const payload = buildPayload(spots, false);
        payloadCache.set(key, { at: Date.now(), payload });
        return { payload, stale: false };
      } catch (error) {
        failedAt.set(key, Date.now());
        if (hit && Date.now() - hit.at < STALE_MS)
          return { payload: hit.payload, stale: true };
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

/** Mount the wave-9 surf & sea-state proxy. */
export function surfProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      const spot = url.searchParams.get('spot');
      if (spot != null) {
        if (!ID_RE.test(spot))
          return sendJson(res, 400, { error: 'surf_bad_spot' }, 'no-store');
        if (!SPOT_BY_ID.has(spot)) {
          return sendJson(res, 200, {
            requestedNotFound: true,
            spot,
            known: SPOTS.map((s) => s.id),
          });
        }
      }
      const { payload, stale } = await getPayload(spot ?? null);
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
          error: 'surf_unavailable',
          detail: error?.message ?? 'unknown',
          honesty: {
            attribution: 'Data: National Weather Service (api.weather.gov).',
          },
        },
        'no-store',
      );
    }
  }

  return {
    name: 'surf',
    configureServer({ middlewares }) {
      middlewares.use('/api/surf', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/surf', handler);
    },
  };
}

export const _surfInternals = {
  UPSTREAM_BASE,
  CACHE_TTL_MS,
  SPOTS,
  parseValidTime,
  parseSpot,
  buildPayload,
  numOrNull,
  M_TO_FT,
  resetCache: () => {
    payloadCache.clear();
    inflight.clear();
    failedAt.clear();
  },
};
