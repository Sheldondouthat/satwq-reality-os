/**
 * Wave 5 — global weather-station ticker (catalog Wave A item 18).
 *
 * WHY A PROXY: nine keyless upstream sources, nine different shapes.
 * This provider fans out to all of them in parallel, trims each to a
 * compact station row, and serves ONE document at /api/wxstations:
 *
 *   { generatedAt, count, sources:[...], stations:[{
 *       source, id, name, lat, lon, tempC, windMs, windDirDeg, rhPct,
 *       pressureHpa, timeMs, kind, coordApprox
 *   }] }
 *
 * SOURCES (all keyless, verified live 2026-09-27):
 *  - nws   NWS station obs      https://api.weather.gov/stations/{id}/observations/latest
 *          (12 stations, verified via /stations/{id} HTTP 200 — User-Agent
 *          REQUIRED; temp °C, wind km/h→m/s, pressure Pa→hPa, coords from
 *          the GeoJSON feature)
 *  - metno MET Norway locationforecast 2.0 compact (User-Agent REQUIRED;
 *          FORECAST not obs — kind:'forecast'; 6 fixed points:
 *          Oslo/Bergen/Tromsø/Trondheim/Stavanger/Longyearbyen)
 *  - smhi  SMHI Sweden open metobs, parameter 1 (air temp °C), 235 stations,
 *          deterministic every-kth sample for globe spread (20 sampled)
 *  - hko   Hong Kong Observatory rhrread — NO coords upstream; all places
 *          pinned to the HK centroid with coordApprox:true (12 live places,
 *          verified against the live rhrread place list)
 *  - nea   Singapore NEA air-temperature — coords from metadata.stations
 *          (12 readings)
 *  - ipma  IPMA Portugal station index — locations ONLY (no temps upstream),
 *          kind:'station-index', tempC:null (20 sampled)
 *  - imgw  IMGW Poland synop — NO coords upstream; pinned to the PL centroid
 *          with coordApprox:true; wind assumed m/s (IMGW synop convention)
 *          (20 sampled)
 *  - eire  Met Éireann obs (9 verified slugs: athenry/dublin/cork/casement/
 *          shannon/belmullet/knock/mullingar/valentia — each verified live:
 *          /observations/{slug}/today → 200 with rows named for the slug;
 *          coords are town approximations with coordApprox:true;
 *          wind assumed km/h (metweb.ie convention) → converted)
 *  - imo   IMO Iceland obs (ids=1 Reykjavík) — no coords upstream; coordApprox.
 *          Extra vedur station ids could NOT be verified (422/5710/13391/
 *          1702/6205/423/421/5702/17026/13002/1601 all returned empty
 *          <observations/>, and no station-list endpoint is exposed), so
 *          IMO stays single-station.
 *
 * STATION-LIST EXPANSION (2026-09-27, branch wave5-recur-stations):
 * every added ID/slug/place was verified against the upstream's own
 * site-list endpoint the same day it was added (see per-source comments).
 * An ID that did not verify was NOT added (rejected: macehead/malin/
 * rochespoint eire slugs — payload rows named "Dublin Airport", i.e.
 * wrong-station fallback; all extra vedur ids — empty observations).
 *
 * HONESTY: coordApprox:true means the position is a network centroid, not a
 * measured station position. kind:'forecast' (MET Norway) and
 * kind:'station-index' (IPMA, no temperatures) are labeled in the dock.
 * A source that fails yields {status:'error'} in sources[] and zero rows —
 * never fake rows.
 *
 * Global fetch only; redirect:'follow' (workerd: 'error' throws at edge, main 2ec4053);
 * capped reads; per-source timeouts; cache + inflight; no node: imports.
 */

import { readResponseJsonCapped, readResponseTextCapped } from '../common/http.js';

const UA = 'GodsEyeView/1.0 (satwq-reality-os; public weather context)';

const SOURCE_TIMEOUT_MS = 20_000; // generous: sweep is parallel + cached 10 min
const CACHE_TTL_MS = 10 * 60_000;
const STALE_MS = 45 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;

/** Finite number or null. null/undefined/'' stay null — never 0. */
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function row(source, fields) {
  return {
    source,
    id: String(fields.id ?? ''),
    name: String(fields.name ?? fields.id ?? ''),
    lat: num(fields.lat),
    lon: num(fields.lon),
    tempC: num(fields.tempC),
    windMs: num(fields.windMs),
    windDirDeg: num(fields.windDirDeg),
    rhPct: num(fields.rhPct),
    pressureHpa: num(fields.pressureHpa),
    timeMs: Number.isFinite(fields.timeMs) ? fields.timeMs : null,
    kind: fields.kind ?? 'obs',
    coordApprox: fields.coordApprox === true,
  };
}

/** Deterministic every-kth sample for globe spread. */
function sampleEvery(arr, every, cap) {
  const out = [];
  for (let i = 0; i < arr.length && out.length < cap; i += every) out.push(arr[i]);
  return out;
}

// NWS station IDs — every one verified live 2026-09-27 via
// https://api.weather.gov/stations/{id} (HTTP 200). Major US airports,
// each with an ASOS station feeding api.weather.gov.
const NWS_IDS = [
  'KROA', 'KJFK', 'KSEA', 'KBOS', // original 4
  'KDCA', 'KATL', 'KMIA', 'KORD', 'KDFW', 'KDEN', 'KLAX', 'KPHX', // added 2026-09-27
];

// Met Éireann station slugs — each verified live 2026-09-27:
// GET https://prodapi.metweb.ie/observations/{slug}/today → 200 with 24 rows
// ALL named for the requested station. Slugs whose payload rows were named
// for a DIFFERENT station (macehead, malin, rochespoint → "Dublin Airport")
// were rejected as unverifiable. Town coords are approximations — always
// served with coordApprox:true (never presented as measured positions).
const EIRE_STATIONS = [
  { slug: 'athenry', name: 'Athenry', lat: 53.29, lon: -8.75 },
  { slug: 'dublin', name: 'Dublin Airport', lat: 53.43, lon: -6.26 },
  { slug: 'cork', name: 'Cork', lat: 51.85, lon: -8.49 },
  { slug: 'casement', name: 'Casement', lat: 53.30, lon: -6.45 },
  { slug: 'shannon', name: 'Shannon', lat: 52.70, lon: -8.92 },
  { slug: 'belmullet', name: 'Belmullet', lat: 54.22, lon: -9.99 },
  { slug: 'knock', name: 'Knock', lat: 53.79, lon: -8.81 },
  { slug: 'mullingar', name: 'Mullingar', lat: 53.52, lon: -7.36 },
  { slug: 'valentia', name: 'Valentia', lat: 51.94, lon: -10.24 },
];

// IMO (vedur.is) station IDs: only ids=1 (Reykjavík) verified. Probes of
// 422/5710/13391/1702/6205/423/421/5702/17026/13002/1601 all returned
// HTTP 200 with EMPTY <observations/> — unverifiable, so NOT added.
// The xmlweather API exposes no station-list endpoint for discovery.
const IMO_STATIONS = [{ id: 1, name: 'Reykjavík', lat: 64.15, lon: -21.94 }];

// ——— per-source parsers (pure; exported for tests) ———

function parseNwsObs(doc, stationId) {
  const p = doc?.properties;
  if (!p || typeof p !== 'object') return null;
  const coords = doc?.geometry?.coordinates;
  const qv = (o) => (o && typeof o === 'object' ? o.value : null);
  const windMs = num(qv(p.windSpeed)) == null ? null : num(qv(p.windSpeed)) / 3.6; // km/h → m/s
  const pressureHpa = num(qv(p.barometricPressure)) == null
    ? null
    : num(qv(p.barometricPressure)) / 100; // Pa → hPa
  return row('nws', {
    id: stationId,
    name: `${stationId} · NWS`,
    lat: Array.isArray(coords) ? coords[1] : null,
    lon: Array.isArray(coords) ? coords[0] : null,
    tempC: num(qv(p.temperature)),
    windMs,
    windDirDeg: num(qv(p.windDirection)),
    rhPct: num(qv(p.relativeHumidity)),
    pressureHpa,
    timeMs: Date.parse(p.timestamp),
  });
}

function parseMetnoPoint(doc, meta) {
  const ts = doc?.properties?.timeseries?.[0];
  const d = ts?.data?.instant?.details;
  if (!d || typeof d !== 'object') return null;
  return row('metno', {
    id: `metno-${meta.slug}`,
    name: `${meta.name} · MET Norway`,
    lat: meta.lat,
    lon: meta.lon,
    tempC: num(d.air_temperature),
    windMs: num(d.wind_speed),
    windDirDeg: num(d.wind_from_direction),
    rhPct: num(d.relative_humidity),
    pressureHpa: num(d.air_pressure_at_sea_level),
    timeMs: Date.parse(ts.time),
    kind: 'forecast',
  });
}

function parseSmhi(doc, { every = 12, cap = 20 } = {}) {
  const stations = Array.isArray(doc?.station) ? doc.station : [];
  const out = [];
  for (const s of sampleEvery(stations, every, cap)) {
    const v = Array.isArray(s?.value) ? s.value[s.value.length - 1] : null;
    const r = row('smhi', {
      id: `smhi-${s?.key ?? ''}`,
      name: `${s?.name ?? s?.key ?? ''} · SMHI`,
      lat: num(s?.latitude),
      lon: num(s?.longitude),
      tempC: num(v?.value),
      timeMs: Number.isFinite(v?.date) ? v.date : null,
    });
    if (r.lat != null && r.lon != null && r.tempC != null) out.push(r);
  }
  return out;
}

function parseHko(doc, { places, lat, lon, cap = 4 } = {}) {
  const temps = Array.isArray(doc?.temperature?.data) ? doc.temperature.data : [];
  const hum = Array.isArray(doc?.humidity?.data) ? doc.humidity.data[0] : null;
  const humByPlace = hum?.place ? { [hum.place]: num(hum.value) } : {};
  const out = [];
  for (const t of temps) {
    if (!places.includes(t?.place)) continue;
    const r = row('hko', {
      id: `hko-${t.place}`,
      name: `${t.place} · HKO`,
      lat,
      lon,
      tempC: num(t?.value),
      rhPct: humByPlace[t.place] ?? null,
      timeMs: Date.parse(doc?.updateTime),
      coordApprox: true,
    });
    if (r.tempC != null) out.push(r);
    if (out.length >= cap) break;
  }
  return out;
}

function parseNea(doc, { cap = 12 } = {}) {
  const meta = {};
  for (const s of doc?.metadata?.stations ?? []) {
    meta[s?.id] = s;
  }
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const latest = items[items.length - 1] ?? items[0] ?? {};
  const out = [];
  for (const rd of (latest.readings ?? []).slice(0, cap)) {
    const m = meta[rd?.station_id];
    const r = row('nea', {
      id: `nea-${rd?.station_id ?? ''}`,
      name: `${m?.name ?? rd?.station_id ?? ''} · NEA`,
      lat: num(m?.location?.latitude),
      lon: num(m?.location?.longitude),
      tempC: num(rd?.value),
      timeMs: Date.parse(latest.timestamp),
    });
    if (r.lat != null && r.lon != null && r.tempC != null) out.push(r);
  }
  return out;
}

function parseIpma(doc, { every = 11, cap = 20 } = {}) {
  const feats = Array.isArray(doc) ? doc : [];
  const out = [];
  for (const f of sampleEvery(feats, every, cap)) {
    const c = f?.geometry?.coordinates;
    const r = row('ipma', {
      id: `ipma-${f?.properties?.idEstacao ?? ''}`,
      name: `${f?.properties?.localEstacao ?? ''} · IPMA`,
      lat: Array.isArray(c) ? c[1] : null,
      lon: Array.isArray(c) ? c[0] : null,
      kind: 'station-index',
    });
    if (r.lat != null && r.lon != null) out.push(r);
  }
  return out;
}

function parseImgw(doc, { every = 3, cap = 20, lat, lon } = {}) {
  const rows = Array.isArray(doc) ? doc : [];
  const out = [];
  for (const s of sampleEvery(rows, every, cap)) {
    const r = row('imgw', {
      id: `imgw-${s?.id_stacji ?? ''}`,
      name: `${s?.stacja ?? ''} · IMGW`,
      lat,
      lon,
      tempC: num(s?.temperatura),
      windMs: num(s?.predkosc_wiatru), // IMGW synop convention: m/s
      windDirDeg: num(s?.kierunek_wiatru),
      rhPct: num(s?.wilgotnosc_wzgledna),
      pressureHpa: num(s?.cisnienie),
      timeMs: Date.parse(`${s?.data_pomiaru ?? ''}T${String(s?.godzina_pomiaru ?? '0').padStart(2, '0')}:00:00Z`),
      coordApprox: true,
    });
    if (r.tempC != null) out.push(r);
  }
  return out;
}

function parseEire(doc, { slug = 'athenry', name = null, lat, lon } = {}) {
  const e = Array.isArray(doc) ? doc[0] : doc;
  if (!e || typeof e !== 'object') return null;
  const windMs = num(e?.windSpeed) == null ? null : num(e.windSpeed) / 3.6; // metweb.ie: km/h
  return row('eireann', {
    id: `eireann-${slug}`,
    name: `${name ?? e?.name ?? slug} · Met Éireann`,
    lat,
    lon,
    tempC: num(e?.temperature),
    windMs,
    windDirDeg: num(e?.windDirection),
    rhPct: num(e?.humidity),
    pressureHpa: num(e?.pressure),
    coordApprox: true,
  });
}

function parseImo(text, { id = 1, name = 'Reykjavík', lat, lon } = {}) {
  const m = String(text).match(/<station[^>]*>([\s\S]*?)<\/station>/);
  if (!m) return null;
  const body = m[1];
  const tag = (t) => {
    const mm = body.match(new RegExp(`<${t}>([^<]*)</${t}>`));
    return mm ? mm[1].trim() : null;
  };
  const windMs = num(tag('FX')) == null ? null : num(tag('FX')); // vedur: m/s
  return row('imo', {
    id: `imo-${id}`,
    name: `${tag('name') ?? name} · IMO`,
    lat,
    lon,
    tempC: num(tag('T')),
    windMs,
    windDirDeg: null,
    rhPct: null,
    pressureHpa: null,
    timeMs: Date.parse((tag('time') ?? '').replace(' ', 'T') + 'Z'),
    coordApprox: true,
  });
}

// ——— source table ———

// HKO places — all 12 verified live 2026-09-27 against the rhrread place list
// (27 live places returned; these 12 are a geographic spread across HK).
const HKO_PLACES = [
  'Hong Kong Observatory', "King's Park", 'Wong Chuk Hang', 'Ta Kwu Ling', // original 4
  'Lau Fau Shan', 'Tai Po', 'Sha Tin', 'Tuen Mun', // added 2026-09-27
  'Tseung Kwan O', 'Sai Kung', 'Cheung Chau', 'Chek Lap Kok',
];
const HK = { lat: 22.32, lon: 114.17 };
const PL = { lat: 51.92, lon: 19.15 }; // Poland centroid — coordApprox

const SOURCES = [
  {
    id: 'nws',
    name: 'NWS station observations (US)',
    kind: 'obs',
    cap: 256 * 1024,
    fetch: async (doFetch, signal) => {
      const docs = await Promise.all(NWS_IDS.map(async (sid) => {
        const res = await doFetch(`https://api.weather.gov/stations/${sid}/observations/latest`, signal);
        if (!res.ok) throw new Error(`nws_${sid}_http_${res.status}`);
        return { sid, doc: await readResponseJsonCapped(res, 256 * 1024, signal) };
      }));
      return docs.map(({ sid, doc }) => parseNwsObs(doc, sid)).filter(Boolean);
    },
  },
  {
    id: 'metno',
    name: 'MET Norway locationforecast',
    kind: 'forecast',
    cap: 256 * 1024,
    points: [
      { slug: 'oslo', name: 'Oslo', lat: 59.9, lon: 10.7 },
      { slug: 'bergen', name: 'Bergen', lat: 60.39, lon: 5.32 },
      { slug: 'tromso', name: 'Tromsø', lat: 69.65, lon: 18.96 },
      { slug: 'trondheim', name: 'Trondheim', lat: 63.43, lon: 10.40 }, // added 2026-09-27
      { slug: 'stavanger', name: 'Stavanger', lat: 58.97, lon: 5.73 }, // added 2026-09-27
      { slug: 'longyearbyen', name: 'Longyearbyen', lat: 78.22, lon: 15.63 }, // added 2026-09-27 (Svalbard)
    ],
    fetch: async (doFetch, signal, src) => {
      const docs = await Promise.all(src.points.map(async (pt) => {
        const url = `https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=${pt.lat}&lon=${pt.lon}`;
        const res = await doFetch(url, signal);
        if (!res.ok) throw new Error(`metno_${pt.slug}_http_${res.status}`);
        return { pt, doc: await readResponseJsonCapped(res, 256 * 1024, signal) };
      }));
      return docs.map(({ pt, doc }) => parseMetnoPoint(doc, pt)).filter(Boolean);
    },
  },
  {
    id: 'smhi',
    name: 'SMHI Sweden observations',
    kind: 'obs',
    fetch: async (doFetch, signal) => {
      const res = await doFetch(
        'https://opendata-download-metobs.smhi.se/api/version/1.0/parameter/1/station-set/all/period/latest-hour/data.json',
        signal,
      );
      if (!res.ok) throw new Error(`smhi_http_${res.status}`);
      return parseSmhi(await readResponseJsonCapped(res, 1024 * 1024, signal));
    },
  },
  {
    id: 'hko',
    name: 'Hong Kong Observatory',
    kind: 'obs',
    fetch: async (doFetch, signal) => {
      const res = await doFetch(
        'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en',
        signal,
      );
      if (!res.ok) throw new Error(`hko_http_${res.status}`);
      return parseHko(await readResponseJsonCapped(res, 256 * 1024, signal), {
        places: HKO_PLACES, lat: HK.lat, lon: HK.lon,
      });
    },
  },
  {
    id: 'nea',
    name: 'Singapore NEA',
    kind: 'obs',
    fetch: async (doFetch, signal) => {
      const res = await doFetch('https://api.data.gov.sg/v1/environment/air-temperature', signal);
      if (!res.ok) throw new Error(`nea_http_${res.status}`);
      return parseNea(await readResponseJsonCapped(res, 256 * 1024, signal));
    },
  },
  {
    id: 'ipma',
    name: 'IPMA Portugal (station index)',
    kind: 'station-index',
    fetch: async (doFetch, signal) => {
      const res = await doFetch(
        'https://api.ipma.pt/open-data/observation/meteorology/stations/stations.json',
        signal,
      );
      if (!res.ok) throw new Error(`ipma_http_${res.status}`);
      return parseIpma(await readResponseJsonCapped(res, 1024 * 1024, signal));
    },
  },
  {
    id: 'imgw',
    name: 'IMGW Poland synop',
    kind: 'obs',
    fetch: async (doFetch, signal) => {
      const res = await doFetch('https://danepubliczne.imgw.pl/api/data/synop', signal);
      if (!res.ok) throw new Error(`imgw_http_${res.status}`);
      return parseImgw(await readResponseJsonCapped(res, 512 * 1024, signal), {
        lat: PL.lat, lon: PL.lon,
      });
    },
  },
  {
    id: 'eireann',
    name: 'Met Éireann (9 stations)',
    kind: 'obs',
    fetch: async (doFetch, signal) => {
      const docs = await Promise.all(EIRE_STATIONS.map(async (st) => {
        const res = await doFetch(
          `https://prodapi.metweb.ie/observations/${st.slug}/today`, signal,
        );
        if (!res.ok) throw new Error(`eireann_${st.slug}_http_${res.status}`);
        return parseEire(await readResponseJsonCapped(res, 128 * 1024, signal), st);
      }));
      return docs.filter(Boolean);
    },
  },
  {
    id: 'imo',
    name: 'IMO Iceland (Reykjavík)',
    kind: 'obs',
    fetch: async (doFetch, signal) => {
      const docs = await Promise.all(IMO_STATIONS.map(async (st) => {
        const res = await doFetch(
          `https://xmlweather.vedur.is/?op_w=xml&type=obs&lang=en&view=xml&ids=${st.id}`,
          signal,
        );
        if (!res.ok) throw new Error(`imo_${st.id}_http_${res.status}`);
        const text = await readResponseTextCapped(res, 64 * 1024); // returns the string (throws when too large)
        return parseImo(text, st);
      }));
      return docs.filter(Boolean);
    },
  },
];

async function fetchWithTimeout(fetchImpl, url, signal, timeoutMs = SOURCE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/json, text/xml, */*' },
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

async function sweepAll({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const doFetch = (url, signal) => fetchWithTimeout(fetchImpl, url, signal);
  const settled = await Promise.all(SOURCES.map(async (src) => {
    try {
      const stations = await src.fetch(doFetch, null, src);
      return { id: src.id, name: src.name, kind: src.kind, status: 'ok', count: stations.length, stations };
    } catch (error) {
      return {
        id: src.id, name: src.name, kind: src.kind, status: 'error',
        count: 0, stations: [], error: error?.message ?? 'unknown',
      };
    }
  }));
  const stations = settled.flatMap((s) => s.stations);
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    count: stations.length,
    sources: settled.map(({ stations: _drop, ...meta }) => meta),
    stations,
    stale: false,
    unavailable: stations.length === 0,
    reason: stations.length === 0 ? 'All weather-station sources unreachable.' : null,
    attribution:
      'Station obs: NWS (US PD), MET Norway (CC-BY 4.0), SMHI (open data), HKO (open data), ' +
      'NEA Singapore (via data.gov.sg), IPMA (station locations), IMGW-PIB, Met Éireann, IMO. ' +
      'Coordinates marked coordApprox are network centroids, not measured positions.',
  };
}

export function wxstationsProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cache = null; // { value, fetchedAt }
  let inflight = null;
  let attemptedAt = -Infinity;

  async function acquire(signal) {
    if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) {
      return { value: cache.value, stale: false };
    }
    signal?.throwIfAborted?.();
    if (!inflight) {
      if (now() - attemptedAt < RETRY_COOLDOWN_MS) throw new Error('wxstations_retry_later');
      attemptedAt = now();
      inflight = sweepAll({ fetchImpl, now })
        .then((value) => {
          cache = { value, fetchedAt: now() };
          return { value, stale: false };
        })
        .finally(() => { inflight = null; });
    }
    if (!signal) return inflight;
    const cancelled = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const detach = () => signal.removeEventListener('abort', abort);
      inflight.then(detach, detach);
    });
    return Promise.race([inflight, cancelled]);
  }

  function describe(value, { stale = false, reason = null } = {}) {
    return {
      ...value,
      stale,
      reason: reason ?? value.reason,
    };
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      try {
        const { value, stale } = await acquire(controller.signal);
        json(200, describe(value, { stale }));
      } catch (error) {
        const usable = cache && now() - cache.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(cache.value, { stale: true, reason: 'Upstream unreachable; showing last good sweep.' })
            : {
                schemaVersion: 1,
                generatedAt: new Date(now()).toISOString(),
                count: 0,
                sources: SOURCES.map((s) => ({ id: s.id, name: s.name, kind: s.kind, status: 'error', count: 0 })),
                stations: [],
                stale: false,
                unavailable: true,
                reason: 'Weather-station sources unreachable and no cached sweep exists.',
                attribution: 'Station obs: NWS, MET Norway, SMHI, HKO, NEA, IPMA, IMGW, Met Éireann, IMO.',
              },
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'wxstations',
    configureServer({ middlewares }) {
      middlewares.use('/api/wxstations', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/wxstations', handler);
    },
  };
}

export const _wxstationsInternals = {
  num,
  row,
  sampleEvery,
  parseNwsObs,
  parseMetnoPoint,
  parseSmhi,
  parseHko,
  parseNea,
  parseIpma,
  parseImgw,
  parseEire,
  parseImo,
  sweepAll,
  SOURCES,
  NWS_IDS,
  EIRE_STATIONS,
  IMO_STATIONS,
  HKO_PLACES,
};
