/**
 * Wave 9 — Pembroke home view (GET /api/home).
 *
 * The last Post-D force-multiplier item: a single curated "home" view for
 * the home point (default Pembroke, VA 24136) that aggregates the most
 * relevant live data into one call. No new upstreams — every section reuses
 * a pinned keyless upstream and a parser/check function already proven in a
 * shipped provider (never reimplemented):
 *
 *   weather   Open-Meteo v1/forecast current+today  (fields guarded with
 *             numOrNull; WMO weather-code → words is a static computed map)
 *   alerts    NWS api.weather.gov/alerts/active?point=  (parseNwsAlerts from
 *             wave6/alerts.js; severe subset via checkNwsAlerts from
 *             wave9/alertRules.js run on the same scoped fetch)
 *   air       Open-Meteo air-quality current us_aqi/pm2_5/ozone
 *             (parseModelPayload from wave7/aqModel.js — CAMS model-labeled)
 *   quakes    USGS all-day feed (checkQuakes from wave9/alertRules.js)
 *   faa       nasstatus.faa.gov (checkFaa from wave9/alertRules.js)
 *   mirova    mirovaweb.it/NRT (checkMirova from wave9/alertRules.js)
 *   swpc      SWPC planetary K 1-min (checkSwpc from wave9/alertRules.js)
 *
 * Query: ?lat=&lon= (default = home point, validated ±90/±180), ?name=
 * (optional ≤80-char label; defaults to the home name only when the coords
 * match the home point, else "Custom location"). Malformed → 400.
 *
 * 7 subrequests/refresh max, run in parallel via Promise.allSettled —
 * never sequential × 20s timeouts on a Worker. 10-min TTL + 7d key-scoped
 * stale fallback + 60s retry cooldown. Tripwire rules fail soft per rule;
 * the page 502s only if weather AND alerts AND air all fail (tripwires are
 * global extras, not the home core).
 *
 * HONESTY: aggregation, not a new measurement. Sunrise/sunset and the WMO
 * words are computed/model values (labeled). CAMS air quality is a model,
 * not observations (label carried verbatim from aqModel.js). Tripwires are
 * ours (heuristic thresholds, not agency alert products — MIROVA excepted).
 * Quiet is real: zero alerts / zero firings read as such, never invented.
 */
import { parseNwsAlerts } from '../wave6/alerts.js';
import {
  checkQuakes,
  checkNwsAlerts,
  checkFaa,
  checkMirova,
  checkSwpc,
} from './alertRules.js';
import { parseModelPayload } from '../wave7/aqModel.js';

const USER_AGENT = 'satwq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const STALE_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
const CAP_BYTES = 8_000_000;
const CACHE_CONTROL = 'public, max-age=600';

// Home point: Pembroke, Giles County, VA 24136 — coords verified via
// Open-Meteo geocoding 2026-10-04 (geocoding-api.open-meteo.com, real bytes),
// not guessed. 24136 is Sheldon's home zip.
export const HOME_POINT = {
  name: 'Pembroke, VA 24136',
  lat: 37.31957,
  lon: -80.63895,
};

/** WMO weather-code → words. Static computed map (WMO standard table). */
export const WMO_WORDS = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

/** null-safe number; guards the Number('')===0 / Number(null)===0 trap. */
export function numOrNull(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Validate lat/lon query. Throws {status:400}. */
export function parseLocation(query) {
  const rawLat = query?.lat;
  const rawLon = query?.lon;
  if (rawLat == null && rawLon == null)
    return { ...HOME_POINT, isDefault: true };
  const lat = numOrNull(rawLat);
  const lon = numOrNull(rawLon);
  if (
    lat == null ||
    lon == null ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  )
    throw Object.assign(new Error('home_bad_location'), { status: 400 });
  const name =
    typeof query?.name === 'string' && query.name.trim()
      ? query.name.trim().slice(0, 80)
      : 'Custom location';
  return { name, lat, lon, isDefault: false };
}

/** Build the Open-Meteo forecast URL for a home point. */
export function buildWeatherUrl({ lat, lon }) {
  const p = new URLSearchParams();
  p.set('latitude', String(lat));
  p.set('longitude', String(lon));
  p.set(
    'current',
    'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m,pressure_msl,is_day',
  );
  p.set('daily', 'temperature_2m_max,temperature_2m_min,sunrise,sunset');
  p.set('timezone', 'America/New_York');
  p.set('temperature_unit', 'fahrenheit');
  p.set('forecast_days', '1');
  return `https://api.open-meteo.com/v1/forecast?${p.toString()}`;
}

/** Build the NWS active-alerts point URL. */
export function buildNwsUrl({ lat, lon }) {
  return `https://api.weather.gov/alerts/active?point=${lat},${lon}`;
}

/** Build the Open-Meteo air-quality URL. */
export function buildAirUrl({ lat, lon }) {
  const p = new URLSearchParams();
  p.set('latitude', String(lat));
  p.set('longitude', String(lon));
  p.set('current', 'us_aqi,pm2_5,ozone');
  return `https://air-quality-api.open-meteo.com/v1/air-quality?${p.toString()}`;
}

/**
 * Normalize one Open-Meteo forecast envelope into the home weather shape.
 * Pure, exported for tests. Missing fields read null, never zero-filled.
 */
export function parseHomeWeather(upstream) {
  const current = upstream?.current ?? {};
  const daily = upstream?.daily ?? {};
  const code = numOrNull(current.weather_code);
  return {
    time: typeof current.time === 'string' ? current.time : null,
    timezone: typeof upstream?.timezone === 'string' ? upstream.timezone : null,
    tempF: numOrNull(current.temperature_2m),
    feelsLikeF: numOrNull(current.apparent_temperature),
    humidityPct: numOrNull(current.relative_humidity_2m),
    weatherCode: code == null ? null : Math.round(code),
    weatherWord:
      code == null ? null : (WMO_WORDS[Math.round(code)] ?? 'Unknown code'),
    isDay: current.is_day == null ? null : current.is_day === 1,
    windKmh: numOrNull(current.wind_speed_10m),
    windDeg: numOrNull(current.wind_direction_10m),
    pressureHpa: numOrNull(current.pressure_msl),
    highF: numOrNull(daily?.temperature_2m_max?.[0]),
    lowF: numOrNull(daily?.temperature_2m_min?.[0]),
    sunrise: Array.isArray(daily?.sunrise) ? (daily.sunrise[0] ?? null) : null,
    sunset: Array.isArray(daily?.sunset) ? (daily.sunset[0] ?? null) : null,
    attribution: 'Open-Meteo (keyless model forecast)',
  };
}

// ---------------------------------------------------------------------------
// Fetch machinery (wave9 conventions): per-section TTL + retry cooldown +
// inflight dedupe + key-scoped stale fallback. Sections run in parallel via
// Promise.allSettled — never sequential x 20s timeouts on a Worker.
// ---------------------------------------------------------------------------

async function fetchTextCapped(url, accept) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`home_upstream_${response.status}`), {
        status: 502,
      });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > CAP_BYTES)
      throw Object.assign(new Error('home_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(
      new Error(`home_fetch_failed: ${error?.message ?? 'unknown'}`),
      { status: 502 },
    );
  } finally {
    clearTimeout(timeout);
  }
}

const cache = new Map(); // key -> {at, payload}
const inflight = new Map();
const failedAt = new Map();

function keyFor(sectionId, loc) {
  return `${sectionId}|${loc.lat.toFixed(3)}|${loc.lon.toFixed(3)}`;
}

async function evaluateSection(section, loc) {
  const key = keyFor(section.id, loc);
  const nowMs = Date.now();
  const hit = cache.get(key);
  if (hit && nowMs - hit.at < (section.ttlMs ?? DEFAULT_TTL_MS))
    return { ...hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    const lastFail = failedAt.get(key) ?? -Infinity;
    if (
      nowMs - lastFail < RETRY_COOLDOWN_MS &&
      hit &&
      nowMs - hit.at < STALE_MS
    ) {
      return { ...hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const text = await fetchTextCapped(
          section.url(loc),
          section.accept ?? 'application/json',
        );
        const payload = section.parse(text, loc);
        cache.set(key, { at: Date.now(), payload });
        return { ...payload, stale: false };
      } catch (error) {
        failedAt.set(key, Date.now());
        const staleHit = cache.get(key);
        if (staleHit && nowMs - staleHit.at < STALE_MS)
          return { ...staleHit.payload, stale: true };
        throw Object.assign(error, { sectionId: section.id });
      }
    })();
    inflight.set(key, op);
    try {
      return await op;
    } finally {
      inflight.delete(key);
    }
  }
  return op;
}

const SECTIONS = [
  {
    id: 'weather',
    title: 'Current weather (Open-Meteo)',
    ttlMs: DEFAULT_TTL_MS,
    url: buildWeatherUrl,
    accept: 'application/json',
    parse: (text) => {
      const parsed = parseHomeWeather(JSON.parse(text));
      return { id: 'weather', ok: true, ...parsed };
    },
  },
  {
    id: 'alerts',
    title: 'NWS active alerts at home point',
    ttlMs: DEFAULT_TTL_MS,
    url: buildNwsUrl,
    accept: 'application/geo+json',
    parse: (text) => {
      const raw = JSON.parse(text);
      const alerts = parseNwsAlerts(raw);
      const severe = checkNwsAlerts(raw);
      return {
        id: 'alerts',
        ok: true,
        count: alerts.length,
        severe,
        severeCount: severe.length,
        alerts,
      };
    },
  },
  {
    id: 'air',
    title: 'Air quality (CAMS model)',
    ttlMs: DEFAULT_TTL_MS,
    url: buildAirUrl,
    accept: 'application/json',
    parse: (text, loc) => {
      const parsed = parseModelPayload(JSON.parse(text), {
        lat: loc.lat,
        lon: loc.lon,
      });
      return { id: 'air', ok: true, ...parsed };
    },
  },
  {
    id: 'quakes',
    title: 'M6+ earthquakes (24h, USGS)',
    ttlMs: 15 * 60 * 1000,
    url: () =>
      'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson',
    accept: 'application/geo+json, application/json',
    parse: (text) => ({
      id: 'quakes',
      ok: true,
      firings: checkQuakes(JSON.parse(text)),
    }),
  },
  {
    id: 'faa',
    title: 'FAA ground delays / stops / closures',
    ttlMs: DEFAULT_TTL_MS,
    url: () => 'https://nasstatus.faa.gov/api/airport-status-information',
    accept: 'application/xml, text/xml, */*',
    parse: (text) => ({ id: 'faa', ok: true, firings: checkFaa(text) }),
  },
  {
    id: 'mirova',
    title: 'MIROVA very-high/extreme thermal anomalies',
    ttlMs: 30 * 60 * 1000,
    url: () => 'https://www.mirovaweb.it/NRT/',
    accept: 'text/html, */*',
    parse: (text) => ({ id: 'mirova', ok: true, firings: checkMirova(text) }),
  },
  {
    id: 'swpc',
    title: 'G4+ geomagnetic storm (SWPC planetary K)',
    ttlMs: 15 * 60 * 1000,
    url: () => 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json',
    accept: 'application/json',
    parse: (text) => ({
      id: 'swpc',
      ok: true,
      firings: checkSwpc(JSON.parse(text)),
    }),
  },
];

const HOME_HONESTY = {
  aggregation:
    'This route is an aggregation of seven pinned public feeds into one home-point view — not a new measurement. Each section carries its own ok/stale/error state; quiet sections read quiet, never invented.',
  weatherModel:
    'Current conditions are Open-Meteo model output (not a physical sensor at the home point). Sunrise/sunset and the WMO weather-code words are computed values.',
  camsModel:
    'Air quality is CAMS (Copernicus Atmosphere Monitoring Service) chemistry-transport MODEL output via Open-Meteo — not physical sensor observations.',
  tripwiresOurs:
    'Tripwire thresholds are ours (heuristic, not agency alert products — MIROVA excepted). A firing means the condition was observed in the upstream feed, not that an emergency was declared.',
  scope:
    'NWS alerts are scoped to the home point (api.weather.gov point query); tripwires are national/global feeds. Lat/lon query params move the home point; alerts re-scope to the new point.',
  attribution:
    'Open-Meteo, US National Weather Service, USGS, NOAA SWPC, FAA NAS Status, MIROVA (INGV).',
};

function sectionResult(settled, sectionId) {
  if (settled.status === 'fulfilled') return settled.value;
  const error = settled.reason;
  return {
    id: sectionId,
    ok: false,
    stale: false,
    error: String(error?.message ?? 'unknown'),
  };
}

/** Compose the /api/home payload from section results. Pure (testable). */
export function buildHomePayload(loc, results) {
  const byId = {};
  for (const r of results) byId[r.id] = r;
  const weather = byId.weather ?? { ok: false };
  const alerts = byId.alerts ?? { ok: false };
  const air = byId.air ?? { ok: false };
  const tripwireIds = ['quakes', 'faa', 'mirova', 'swpc'];
  const tripwires = tripwireIds.map((id) => byId[id] ?? { ok: false });
  const firing = tripwires.flatMap((t) =>
    Array.isArray(t.firings) ? t.firings : [],
  );
  const sources = {};
  for (const r of results) {
    sources[r.id] = {
      ok: !!r.ok,
      stale: !!r.stale,
      ...(r.ok ? {} : { error: r.error ?? 'unknown' }),
    };
  }
  return {
    generatedAt: new Date().toISOString(),
    home: {
      name: loc.name,
      lat: loc.lat,
      lon: loc.lon,
      isDefault: !!loc.isDefault,
      timezone: weather.timezone ?? null,
    },
    weather,
    alerts,
    airQuality: air,
    tripwires: {
      ok: tripwires.some((t) => t.ok),
      firing,
      firingCount: firing.length,
      rules: tripwires.map((t) => ({
        id: t.id,
        ok: !!t.ok,
        stale: !!t.stale,
        firings: Array.isArray(t.firings) ? t.firings.length : null,
      })),
    },
    briefing: { url: '/api/morning-briefing' },
    sources,
    honesty: HOME_HONESTY,
  };
}

async function getHome(loc) {
  const settled = await Promise.allSettled(
    SECTIONS.map((s) => evaluateSection(s, loc)),
  );
  const results = settled.map((st, i) => sectionResult(st, SECTIONS[i].id));
  const core = ['weather', 'alerts', 'air'].map(
    (id) => results.find((r) => r.id === id) ?? { ok: false },
  );
  if (!core.some((r) => r.ok)) {
    throw Object.assign(
      new Error(
        `home_all_core_down: ${results.map((r) => `${r.id}:${r.error ?? 'ok'}`).join('; ')}`,
      ),
      { status: 502 },
    );
  }
  return buildHomePayload(loc, results);
}

function sendJson(res, status, body, cacheControl = CACHE_CONTROL) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 home-point aggregation proxy. */
export function homeProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let loc;
    try {
      const url = new URL(req.url ?? '/api/home', 'http://localhost');
      loc = parseLocation({
        lat: url.searchParams.get('lat'),
        lon: url.searchParams.get('lon'),
        name: url.searchParams.get('name'),
      });
    } catch (error) {
      return sendJson(
        res,
        400,
        { error: 'home_bad_location', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
    try {
      sendJson(res, 200, await getHome(loc));
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'home_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'home',
    configureServer({ middlewares }) {
      middlewares.use('/api/home', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/home', handler);
    },
  };
}

export const _homeInternals = {
  HOME_HONESTY,
  SECTIONS,
  evaluateSection,
  sectionResult,
  keyFor,
  clearCaches: () => {
    cache.clear();
    failedAt.clear();
  },
};
