/**
 * Wave 9 (R2-9) — Harmful algal bloom (red tide) provider
 * (CalHABMAP via SCCOOS ERDDAP, keyless).
 *
 * Backlog R2-9 ("red tide / HAB bulletins"): the round-2 audit noted "NOAA
 * HAB RSS" — no machine-readable NOAA HAB RSS/REST pull feed was found
 * (NCCOS distributes via email bulletins; NOAA HAB bulletins are PDFs).
 * What DOES exist, keyless and live, is the California Harmful Algal Bloom
 * Monitoring and Alert Program (CalHABMAP) ERDDAP on erddap.sccoos.org:
 * weekly pier plankton counts (cells/L) for the HAB taxa plus domoic-acid
 * measurements (ng/mL). Verified live from the build VM 2026-10-01.
 *
 * Discovery: https://erddap.sccoos.org/erddap/info/index.json
 *   ?itemsPerPage=10000&page=1&searchFor=%22HABs%22
 *   → 18 HABs-* datasets (17 piers/bays + buoys).
 *
 * Live stations pinned (9): last sample within 90 days of 2026-10-01
 * (CalPolyPier, MontereyWharf, SantaCruzWharf, SantaMonicaPier, ScrippsPier,
 * MorroBayBackBay 2026-09-01, MorroBayFrontBay 2026-09-01,
 * NewportBeachPier 2026-08-18, StearnsWharf 2026-08-17).
 * PARKED (data ended months ago, ERDDAP 404 "outside actual_range"):
 *   BodegaMarineLabBuoy (2026-01-28), BodegaMarineLab (2026-04-13),
 *   Humboldt (2026-04-07), HumboldtSouthBay (2026-03-30),
 *   InnerTomalesBay (2026-03-03), TomalesBayMid-ChannelBuoy (2026-03-03),
 *   TomalesBayMouth (2026-03-03), TrinidadPier (2026-04-17).
 * Re-verify before re-adding; the provider marks any newly-dark pinned
 * station ok:false with error 'no_recent_samples' rather than dropping it.
 *
 * Thresholds (labels only, NOT measurements):
 *   BLOOM_CELLS_PER_L = 10,000 cells/L — C-HARM (CalHABMAP) published
 *     bloom threshold (from the project's published threshold docs).
 *   PDA_ALERT_NG_PER_ML = 0.5 ng/mL — C-HARM published 500 ng/L pDA
 *     threshold, converted (500 ng/L = 0.5 ng/mL; upstream units are ng/mL).
 * Sampling is weekly, so 'background' means "not observed in the latest
 * sample", never "the ocean is clear".
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Routes:
 *   GET /api/hab                 → all 9 pinned stations (≤9 subrequests)
 *   GET /api/hab?station=scripps → one pinned station (1 subrequest)
 *   ?station=<unknown-but-wellformed> → 200 {requestedNotFound:true}
 *     (nexrad/goes/pollen pattern)
 *   bad station id → 400
 *
 * 12h TTL (weekly sampling) + 14d key-scoped stale fallback; per-station
 * fail-soft (all stations unreachable → honest 502).
 */

const ERDDAP_BASE = 'https://erddap.sccoos.org/erddap/tabledap';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 256 * 1024; // observed ≤ 2 KB per station; generous headroom
const CACHE_TTL_MS = 12 * 3600_000; // weekly sampling cadence
const STALE_MS = 14 * 24 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const WINDOW_DAYS = 90; // only stations with samples inside this window stay live
const USER_AGENT = 'satwq-reality-os/1.0 (gods-eye-view; hab layer; keyless)';

/** C-HARM published thresholds, applied as labels (see header). */
export const BLOOM_CELLS_PER_L = 10_000;
export const PDA_ALERT_NG_PER_ML = 0.5; // = 500 ng/L published

/** ERDDAP variable names for the HAB taxa we surface. */
export const TAXA_VARS = [
  'Lingulodinium_polyedra', // red-tide organism (CA)
  'Alexandrium_spp', // PSP producer
  'Dinophysis_spp', // DSP producer
  'Pseudo_nitzschia_delicatissima_group', // domoic-acid producer
  'Pseudo_nitzschia_seriata_group', // domoic-acid producer
  'Akashiwo_sanguinea',
  'Gymnodinium_spp',
  'Cochlodinium_spp',
  'Ceratium_spp',
  'Prorocentrum_spp',
];

export const OTHER_VARS = [
  'pDA', // particulate domoic acid, ng/mL
  'tDA', // total domoic acid, ng/mL
  'dDA', // dissolved domoic acid, ng/mL
  'Temp', // sea water temperature, degree_C
  'Salinity', // PSS
  'Total_Phytoplankton', // cells/L
];

/** Pinned stations — dataset IDs are the ERDDAP HABs-* suffixes. */
export const STATIONS = [
  {
    id: 'scripps',
    dataset: 'HABs-ScrippsPier',
    name: 'Scripps Pier',
    region: 'San Diego',
  },
  {
    id: 'santamonica',
    dataset: 'HABs-SantaMonicaPier',
    name: 'Santa Monica Pier',
    region: 'Los Angeles',
  },
  {
    id: 'calpoly',
    dataset: 'HABs-CalPolyPier',
    name: 'Cal Poly Pier',
    region: 'San Luis Obispo',
  },
  {
    id: 'monterey',
    dataset: 'HABs-MontereyWharf',
    name: 'Monterey Wharf',
    region: 'Monterey Bay',
  },
  {
    id: 'santacruz',
    dataset: 'HABs-SantaCruzWharf',
    name: 'Santa Cruz Wharf',
    region: 'Monterey Bay',
  },
  {
    id: 'morrobay-back',
    dataset: 'HABs-MorroBayBackBay',
    name: 'Morro Bay Back Bay',
    region: 'Central Coast',
  },
  {
    id: 'morrobay-front',
    dataset: 'HABs-MorroBayFrontBay',
    name: 'Morro Bay Front Bay',
    region: 'Central Coast',
  },
  {
    id: 'newport',
    dataset: 'HABs-NewportBeachPier',
    name: 'Newport Beach Pier',
    region: 'Orange County',
  },
  {
    id: 'stearns',
    dataset: 'HABs-StearnsWharf',
    name: 'Stearns Wharf',
    region: 'Santa Barbara',
  },
];

/** Number(null)===0 guard: null/NaN/empty upstream numerics become null, never 0. */
export function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const STATION_ID_RE = /^[a-z][a-z0-9-]{0,39}$/;

/**
 * Validate the query. Returns {mode:'all'|'station'|'notfound', station?}.
 * Throws {status:400} on malformed input; unknown-but-wellformed station
 * ids return {mode:'notfound'} (200 + requestedNotFound). Pure, for tests.
 */
export function parseQuery(query) {
  const raw = query.get('station');
  if (raw != null && raw !== '') {
    if (!STATION_ID_RE.test(raw))
      throw Object.assign(new Error('hab_bad_station'), { status: 400 });
    const found = STATIONS.find((s) => s.id === raw);
    if (!found) return { mode: 'notfound', station: raw };
    return { mode: 'station', station: found };
  }
  return { mode: 'all' };
}

export function selectionStations(sel) {
  if (sel.mode === 'station') return [sel.station];
  return STATIONS;
}

export function buildUpstreamUrl(station, cutoffIso) {
  const vars = [
    'time',
    'latitude',
    'longitude',
    ...TAXA_VARS,
    ...OTHER_VARS,
  ].join(',');
  // The constraint operator must be literal in the query string: ERDDAP
  // reads `time>=...` as variable "time" with operator ">=". A
  // URLSearchParams `time=` param serializes to `time=%3E%3D...`, which
  // ERDDAP rejects as variable "time=" (observed 400). Colons in the ISO
  // timestamp are legal unencoded in query strings.
  return `${ERDDAP_BASE}/${station.dataset}.json?${vars}&time>=${cutoffIso}&orderBy(%22time%22)`;
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
      const text = await response.text().catch(() => '');
      // ERDDAP 404 "outside of the variable's actual_range" = station has
      // no samples in the window → dark station, not a broken query.
      const noRecent =
        response.status === 404 &&
        /outside of the variable's actual_range/.test(text);
      throw Object.assign(
        new Error(
          noRecent
            ? 'hab_no_recent_samples'
            : `hab_upstream_${response.status}`,
        ),
        { status: 502, noRecent },
      );
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('hab_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } catch (error) {
    if (error?.status === 502) throw error;
    if (error instanceof SyntaxError)
      throw Object.assign(new Error('hab_upstream_bad_json'), { status: 502 });
    throw Object.assign(
      new Error(`hab_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

function colIndex(names, want) {
  const i = names.indexOf(want);
  return i >= 0 ? i : -1;
}

/** Taxon alert for one cells/L value. Pure, exported for tests. */
export function taxonAlert(cellsPerL) {
  if (cellsPerL == null) return 'nodata';
  if (cellsPerL >= BLOOM_CELLS_PER_L) return 'bloom';
  if (cellsPerL > 0) return 'present';
  return 'background';
}

/**
 * Parse one station's ERDDAP table into the station row. Pure, exported
 * for tests. Takes the latest row (last in ascending time order).
 * Throws {status:502} on bad shape (never returns fabricated counts).
 */
export function parseStationPayload(upstream, station, nowMs = Date.now()) {
  const fail = (msg) =>
    Object.assign(new Error(`hab_invalid_payload: ${msg}`), { status: 502 });
  const table = upstream?.table;
  const names = table?.columnNames;
  const rows = table?.rows;
  if (!Array.isArray(names) || !Array.isArray(rows))
    throw fail('missing table');
  if (rows.length === 0) throw fail('empty rows');
  const idx = {};
  for (const v of [
    'time',
    'latitude',
    'longitude',
    ...TAXA_VARS,
    ...OTHER_VARS,
  ]) {
    const i = colIndex(names, v);
    if (i < 0) throw fail(`missing column ${v}`);
    idx[v] = i;
  }
  const last = rows[rows.length - 1];
  const timeIso = typeof last[idx.time] === 'string' ? last[idx.time] : null;
  if (!timeIso) throw fail('missing time on latest row');
  const sampleMs = Date.parse(timeIso);
  const ageDays = Number.isFinite(sampleMs)
    ? (nowMs - sampleMs) / 86_400_000
    : null;

  const taxa = {};
  const alerts = {};
  for (const v of TAXA_VARS) {
    const val = numOrNull(last[idx[v]]);
    taxa[v] = val;
    alerts[v] = taxonAlert(val);
  }
  // Pseudo-nitzschia (domoic-acid producers) combined; nulls never zero-filled.
  const pnVals = [
    taxa.Pseudo_nitzschia_delicatissima_group,
    taxa.Pseudo_nitzschia_seriata_group,
  ];
  const pnKnown = pnVals.filter((v) => v != null);
  taxa.pseudo_nitzschia_combined = pnKnown.length
    ? pnKnown.reduce((a, b) => a + b, 0)
    : null;
  alerts.pseudo_nitzschia_combined = taxonAlert(taxa.pseudo_nitzschia_combined);

  const pDA = numOrNull(last[idx.pDA]);
  const tDA = numOrNull(last[idx.tDA]);
  const dDA = numOrNull(last[idx.dDA]);
  const toxinAlert = pDA != null && pDA >= PDA_ALERT_NG_PER_ML;

  const anyBloom = Object.values(alerts).includes('bloom');
  const anyPresent = Object.values(alerts).includes('present');
  const alertLevel = anyBloom
    ? 'bloom'
    : toxinAlert
      ? 'toxin-alert'
      : anyPresent
        ? 'present'
        : 'background';
  const alertTaxa = Object.entries(alerts)
    .filter(
      ([, a]) => a === 'bloom' || (a === 'present' && alertLevel !== 'bloom'),
    )
    .map(([v]) => v);

  return {
    id: station.id,
    dataset: station.dataset,
    name: station.name,
    region: station.region,
    lat: numOrNull(last[idx.latitude]),
    lon: numOrNull(last[idx.longitude]),
    ok: true,
    latestSample: timeIso,
    sampleAgeDays: ageDays == null ? null : Math.round(ageDays * 10) / 10,
    fresh: ageDays != null && ageDays <= 21,
    taxa,
    taxaAlerts: alerts,
    domoicAcid: { pDA, tDA, dDA, toxinAlert, units: 'ng/mL' },
    tempC: numOrNull(last[idx.Temp]),
    salinity: numOrNull(last[idx.Salinity]),
    totalPhytoplankton: numOrNull(last[idx.Total_Phytoplankton]),
    alertLevel,
    alertTaxa,
    rowCount: rows.length,
  };
}

/** Build the full payload envelope. Pure apart from generatedAt. */
export function buildPayload(rows, stale) {
  return {
    generatedAt: new Date().toISOString(),
    stale: Boolean(stale),
    source:
      'CalHABMAP (California Harmful Algal Bloom Monitoring and Alert Program) via SCCOOS ERDDAP',
    attribution:
      'Data: SCCOOS / CalHABMAP (erddap.sccoos.org), keyless tabledap. Thresholds: C-HARM published.',
    units: {
      cells: 'cells/L',
      domoicAcid: 'ng/mL',
      temp: 'degree_C',
      salinity: 'PSS',
    },
    thresholds: {
      bloomCellsPerL: BLOOM_CELLS_PER_L,
      pdaAlertNgPerMl: PDA_ALERT_NG_PER_ML,
      note: 'C-HARM published thresholds applied as LABELS: 10,000 cells/L bloom; 500 ng/L pDA (= 0.5 ng/mL).',
    },
    stations: rows,
    honesty: {
      values:
        "Weekly pier plankton counts (cells/L) and domoic-acid measurements (ng/mL); null = not yet analyzed, never zero-filled (Number('')===0 trap guarded). Real zeros are reported as 0.",
      background:
        '"background" means not observed in the latest weekly sample — never "the ocean is clear".',
      fresh: 'fresh = latest sample ≤ 21 days old (weekly cadence + lab lag).',
      dark: 'ok:false stations had no samples inside the 90-day window (ERDDAP 404 "outside actual_range").',
    },
  };
}

// --- caches (per query key, mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;
const PAYLOAD_CACHE_MAX = 16;

function queryKey(sel) {
  if (sel.mode === 'station') return `station:${sel.station.id}`;
  return 'all';
}

function cutoffIso() {
  return new Date(Date.now() - WINDOW_DAYS * 86_400_000).toISOString();
}

async function fetchOne(station) {
  try {
    const upstream = await fetchJsonCapped(
      buildUpstreamUrl(station, cutoffIso()),
    );
    return parseStationPayload(upstream, station);
  } catch (error) {
    if (error?.noRecent) {
      return {
        id: station.id,
        dataset: station.dataset,
        name: station.name,
        region: station.region,
        lat: null,
        lon: null,
        ok: false,
        error: 'no_recent_samples',
        note: 'No samples inside the 90-day window (station dark or discontinued).',
      };
    }
    return {
      id: station.id,
      dataset: station.dataset,
      name: station.name,
      region: station.region,
      lat: null,
      lon: null,
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
      const stations = selectionStations(sel);
      const rows = await Promise.all(stations.map((s) => fetchOne(s)));
      const okRows = rows.filter((r) => r.ok);
      if (okRows.length === 0) {
        docFailedAt = Date.now();
        if (hit && now - hit.at < STALE_MS)
          return { payload: hit.payload, stale: true };
        throw Object.assign(new Error('hab_all_upstreams_failed'), {
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

function sendJson(res, status, body, cacheControl = 'public, max-age=43200') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 HAB proxy. */
export function habProxy() {
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
          station: sel.station,
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
          error: 'hab_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'hab',
    configureServer({ middlewares }) {
      middlewares.use('/api/hab', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/hab', handler);
    },
  };
}

export const _habInternals = {
  parseQuery,
  parseStationPayload,
  buildPayload,
  buildUpstreamUrl,
  selectionStations,
  taxonAlert,
  clearCaches: () => {
    payloadCache.clear();
    inflight.clear();
    docFailedAt = -Infinity;
  },
};
