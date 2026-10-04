/**
 * Wave 6 — station-data layer proxy: public weather-station integrations (all keyless).
 *
 * Aggregates station metadata and latest observations from seven public
 * station sources into one normalized layer:
 *
 *   #123 GeoSphere Austria — station/current TAWES 10-min (JSON, CC-BY 4.0)
 *   #92  AWDB SNOTEL      — USDA snow-station inventory, VA (JSON, USDA PD)
 *   #93  IEM ASOS         — Iowa Environmental Mesonet network inventory (GeoJSON, open)
 *   #90  EC hydrometric   — Environment Canada station list (CSV, OGL-Canada)
 *   #126 EC citypage      — Environment Canada citypage XML, dir → latest (XML, OGL-Canada)
 *   #117 FMI Finland      — open WFS stored query, Helsinki observations (XML, open)
 *   #113 DWD climate      — CDC recent daily-kl dir listing, reporting station IDs (DWD open)
 *
 * Routes:
 *   GET /api/stations-ext → {generatedAt, sources:{...}, stationCount, stations:[...]}
 *
 * Stations are normalized to {id, name, lat, lon, network, obs} where obs is
 * null when a source carries metadata only. Per-source failures are recorded
 * honestly; a 502 is returned only when EVERY source fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_STATIONS = 600;
const USER_AGENT = 'Gods Eye View (public station-data context)';

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampLatLon(lat, lon) {
  // NOTE: Number(null) === 0, so nulls must be screened before coercion.
  if (lat == null || lon == null || lat === '' || lon === '') return null;
  const la = Number(lat);
  const lo = Number(lon);
  if (!Number.isFinite(la) || !Number.isFinite(lo)) return null;
  if (la < -90 || la > 90 || lo < -180 || lo > 180) return null;
  return {
    lat: Math.round(la * 10000) / 10000,
    lon: Math.round(lo * 10000) / 10000,
  };
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeStation({ id, name, lat, lon, network, obs }) {
  if (!id) return null;
  const ll = clampLatLon(lat, lon);
  return {
    id: String(id),
    name: String(name ?? '').slice(0, 240),
    lat: ll?.lat ?? null,
    lon: ll?.lon ?? null,
    network: String(network ?? ''),
    obs: obs && typeof obs === 'object' ? obs : null,
  };
}

async function fetchTextCapped(url, tag) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`stations_${tag}_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`stations_${tag}_upstream_too_large`), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJsonCapped(url, tag) {
  return JSON.parse(await fetchTextCapped(url, tag));
}

// ——— source fetchers: each returns {stations:[...]} or throws ———

/** GeoSphere TAWES 10-min current: features[].properties.parameters.TL.data=[{t,v}]. */
async function fetchGeosphere() {
  const url =
    'https://dataset.api.hub.geosphere.at/v1/station/current/tawes-v1-10min?parameters=TL&station_ids=11035';
  const upstream = await fetchJsonCapped(url, 'geosphere');
  const out = [];
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  for (const f of features) {
    const props = f?.properties ?? {};
    const coords = f?.geometry?.coordinates;
    const params = props.parameters ?? {};
    const tlData = Array.isArray(params.TL?.data) ? params.TL.data : [];
    const latest = tlData[tlData.length - 1];
    const obs =
      latest && latest.t != null
        ? {
            airTempC: numOrNull(latest.v),
            observedAt: String(latest.t),
            parameter: 'TL (air temperature)',
          }
        : null;
    const s = normalizeStation({
      id: `geosphere:${props.station_id ?? 'unknown'}`,
      name: props.station_name ?? 'GeoSphere TAWES station',
      lat: coords?.[1],
      lon: coords?.[0],
      network: 'GeoSphere-TAWES',
      obs,
    });
    if (s) out.push(s);
  }
  return { stations: out };
}

/** AWDB station inventory (JSON array). */
async function fetchAwdb() {
  const url =
    'https://wcc.sc.egov.usda.gov/awdbRestApi/services/v1/stations?stateCode=VA&networkCodes=SNTL';
  const upstream = await fetchJsonCapped(url, 'awdb');
  const list = Array.isArray(upstream)
    ? upstream
    : Array.isArray(upstream?.stations)
      ? upstream.stations
      : [];
  const out = [];
  for (const s of list) {
    const st = normalizeStation({
      id: `awdb:${s?.stationTriplet ?? s?.id ?? ''}`,
      name: s?.name,
      lat: s?.latitude,
      lon: s?.longitude,
      network: `AWDB-${s?.networkCode ?? 'SNTL'}`,
      obs: null,
    });
    if (st) out.push(st);
  }
  return { stations: out };
}

/** IEM network inventory (GeoJSON metadata). */
async function fetchIem() {
  const url =
    'https://mesonet.agron.iastate.edu/geojson/network/IA_ASOS.geojson';
  const upstream = await fetchJsonCapped(url, 'iem');
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const c = f?.geometry?.coordinates;
    const s = normalizeStation({
      id: `iem:${p.sid ?? p.id ?? ''}`,
      name: p.sname ?? p.name,
      lat: c?.[1] ?? p.lat,
      lon: c?.[0] ?? p.lon,
      network: `IEM-${p.network ?? 'ASOS'}`,
      obs: null,
    });
    if (s) out.push(s);
  }
  return { stations: out };
}

/** EC hydrometric station list (CSV). */
export function parseHydrometricCsv(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    // ID,"NAME",lat,lon,prov,timezone — names are quoted, no embedded commas.
    const m = line.match(/^([^,]+),"([^"]*)",([^,]+),([^,]+),([^,]+),(.+)$/);
    if (!m) continue;
    const s = normalizeStation({
      id: `ec-hydro:${m[1].trim()}`,
      name: m[2].trim(),
      lat: m[3].trim(),
      lon: m[4].trim(),
      network: `EC-HYDRO-${m[5].trim()}`,
      obs: null,
    });
    if (s) out.push(s);
    if (out.length >= MAX_STATIONS) break;
  }
  return out;
}

async function fetchEcHydrometric() {
  const url =
    'https://dd.weather.gc.ca/today/hydrometric/doc/hydrometric_StationList.csv';
  return {
    stations: parseHydrometricCsv(await fetchTextCapped(url, 'ec_hydro')),
  };
}

/** EC citypage: dir listing → latest XML for s0000422 (Toronto) → current conditions. */
export function parseCitypageXml(xml, filename) {
  const current =
    /<currentConditions>([\s\S]*?)<\/currentConditions>/.exec(
      String(xml ?? ''),
    )?.[1] ?? '';
  const locBlock =
    /<location>([\s\S]*?)<\/location>/.exec(String(xml ?? ''))?.[1] ?? '';
  const grab = (block, tag) => {
    const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`)
      .exec(block)?.[1]
      ?.trim();
    return m === '' ? null : (m ?? null);
  };
  const temp = grab(current, 'temperature');
  const obs = {
    tempC: numOrNull(temp),
    condition: grab(current, 'condition'),
    humidityPct: numOrNull(grab(current, 'relativeHumidity')),
    pressureKpa: numOrNull(grab(current, 'pressure')),
    windKph: numOrNull(grab(current, 'wind')?.match(/[\d.]+/)?.[0] ?? null),
    observedAt:
      /<dateTime[^>]*name="observation"[^>]*>[\s\S]*?<timeStamp>(\d+)<\/timeStamp>/.exec(
        current,
      )?.[1] ?? null,
  };
  if (obs.observedAt && /^\d{14}$/.test(obs.observedAt)) {
    obs.observedAt = obs.observedAt.replace(
      /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/,
      '$1-$2-$3T$4:$5:$6Z',
    );
  }
  const s = normalizeStation({
    id: `ec-citypage:${/s\d+/.exec(filename ?? '')?.[0] ?? 's0000422'}`,
    name: grab(locBlock, 'name') ?? 'Environment Canada citypage site',
    lat: grab(locBlock, 'latitude'),
    lon: grab(locBlock, 'longitude'),
    network: 'EC-CITYPAGE',
    obs,
  });
  return s ? [s] : [];
}

async function fetchEcCitypage() {
  const dir = await fetchTextCapped(
    'https://dd.weather.gc.ca/today/citypage_weather/ON/05/',
    'ec_citypage_dir',
  );
  const files = [
    ...dir.matchAll(
      /href="(\d{8}T\d{6}(?:\.\d+)?Z_MSC_CitypageWeather_s0000422_en\.xml)"/g,
    ),
  ].map((m) => m[1]);
  if (!files.length)
    throw Object.assign(new Error('stations_ec_citypage_no_files'), {
      status: 502,
    });
  files.sort();
  const latest = files[files.length - 1];
  const xml = await fetchTextCapped(
    `https://dd.weather.gc.ca/today/citypage_weather/ON/05/${latest}`,
    'ec_citypage_xml',
  );
  return { stations: parseCitypageXml(xml, latest) };
}

/** FMI open WFS: Helsinki observations via stored query (XML, defensive regex parse). */
export function parseFmiWfs(xml) {
  const blocks = [
    ...String(xml ?? '').matchAll(
      /<BsWfs:BsWfsElement[\s\S]*?<\/BsWfs:BsWfsElement>/g,
    ),
  ];
  const byStation = new Map();
  for (const [block] of blocks) {
    const pos = /<gml:pos>([^<]+)<\/gml:pos>/.exec(block)?.[1];
    const time = /<gml:timePosition>([^<]+)<\/gml:timePosition>/.exec(
      block,
    )?.[1];
    const pname = /<BsWfs:ParameterName>([^<]+)<\/BsWfs:ParameterName>/.exec(
      block,
    )?.[1];
    const pvalue = /<BsWfs:ParameterValue>([^<]+)<\/BsWfs:ParameterValue>/.exec(
      block,
    )?.[1];
    if (!pos || !pname) continue;
    const [lat, lon] = pos.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    let st = byStation.get(key);
    if (!st) {
      st = { lat, lon, time: null, params: {} };
      byStation.set(key, st);
    }
    st.params[pname] = numOrNull(pvalue);
    if (time && (!st.time || time > st.time)) st.time = time;
  }
  const out = [];
  for (const [key, st] of byStation) {
    const s = normalizeStation({
      id: `fmi:${key}`,
      name: `FMI observation ${key}`,
      lat: st.lat,
      lon: st.lon,
      network: 'FMI-WFS',
      obs: { observedAt: st.time, ...st.params },
    });
    if (s) out.push(s);
  }
  return out;
}

async function fetchFmi() {
  const now = Date.now();
  const end = new Date(now - 5 * 60_000).toISOString();
  const start = new Date(now - 70 * 60_000).toISOString();
  const url = `https://opendata.fmi.fi/wfs?service=WFS&version=2.0.0&request=GetFeature&storedquery_id=fmi::observations::weather::simple&place=Helsinki&starttime=${encodeURIComponent(start)}&endtime=${encodeURIComponent(end)}`;
  return { stations: parseFmiWfs(await fetchTextCapped(url, 'fmi')) };
}

/** DWD CDC recent dir listing → station IDs that reported in the last daily batch. */
export function parseDwdRecentDir(html) {
  const links = [
    ...String(html ?? '').matchAll(/href="(tageswerte_KL_(\d{5})_akt\.zip)"/g),
  ];
  const seen = new Map();
  for (const [, file, stationId] of links) {
    const date =
      /(\d{2}-[A-Za-z]{3}-\d{4})/.exec(
        html.slice(html.indexOf(`"${file}"`), html.indexOf(`"${file}"`) + 220),
      )?.[1] ?? null;
    if (!seen.has(stationId)) seen.set(stationId, { file, date });
  }
  const out = [];
  for (const [stationId, { file, date }] of seen) {
    const s = normalizeStation({
      id: `dwd:${stationId}`,
      name: `DWD climate station ${stationId}`,
      lat: null,
      lon: null,
      network: 'DWD-CLI',
      obs: { reportingFile: file, listingDate: date },
    });
    if (s) out.push(s);
  }
  return out;
}

async function fetchDwdClimate() {
  const url =
    'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/kl/recent/';
  return { stations: parseDwdRecentDir(await fetchTextCapped(url, 'dwd')) };
}

const SOURCES = [
  {
    key: 'geosphere',
    fetch: fetchGeosphere,
    attribution: 'GeoSphere Austria (CC-BY 4.0)',
  },
  { key: 'awdb', fetch: fetchAwdb, attribution: 'USDA AWDB (public domain)' },
  {
    key: 'iem',
    fetch: fetchIem,
    attribution: 'Iowa Environmental Mesonet (open)',
  },
  {
    key: 'ec_hydrometric',
    fetch: fetchEcHydrometric,
    attribution: 'Environment Canada (OGL-Canada)',
  },
  {
    key: 'ec_citypage',
    fetch: fetchEcCitypage,
    attribution: 'Environment Canada (OGL-Canada)',
  },
  {
    key: 'fmi',
    fetch: fetchFmi,
    attribution: 'Finnish Meteorological Institute (open data)',
  },
  {
    key: 'dwd',
    fetch: fetchDwdClimate,
    attribution: 'Deutscher Wetterdienst (open data)',
  },
];

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const { stations } = await source.fetch();
    return {
      key: source.key,
      ok: true,
      count: stations.length,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      stations,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      stations: [],
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const stations = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    stations.push(...r.stations);
  }
  // Stations with live observations first.
  stations.sort((a, b) => (b.obs ? 1 : 0) - (a.obs ? 1 : 0));
  return {
    generatedAt: new Date().toISOString(),
    sources,
    stationCount: stations.length,
    stations: stations.slice(0, MAX_STATIONS),
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(SOURCES.map(fetchOneSource))
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(
            new Error(`stations_all_upstream_down: ${detail}`),
            { status: 502 },
          );
        }
        const payload = buildSnapshot(results);
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

/** Mount the station-data layer proxy. Mirrors the wave-5 quakes multi-source shape. */
export function stationsExtProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'stations_ext_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'stations-ext',
    configureServer({ middlewares }) {
      middlewares.use('/api/stations-ext', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/stations-ext', handler);
    },
  };
}

export const _stationsExtInternals = {
  parseHydrometricCsv,
  parseCitypageXml,
  parseFmiWfs,
  parseDwdRecentDir,
  normalizeStation,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
