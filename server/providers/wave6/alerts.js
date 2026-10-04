/**
 * Wave 6 — consolidated weather-alert aggregation proxy (all keyless).
 *
 * NOTE on repo ground truth (2026-09-27): no /api/alerts provider existed —
 * the only weather-alert provider was wave3/nwsAlerts.js at /api/nws-alerts.
 * This module creates the /api/alerts route (no duplicate: nothing else
 * serves it) and aggregates:
 *
 *   NWS  https://api.weather.gov/alerts/active?status=actual
 *        US National Weather Service GeoJSON alerts (keyless).
 *   #111 DWD https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json
 *        Deutscher Wetterdienst warnapp feed (keyless). Served as JSONP —
 *        `warnWetter.loadWarnings({...})` — so the provider unwraps it.
 *        Carries no geometry (polygons only exist in the heavier #112 CAP
 *        XML dir listing, deliberately not crawled); alerts are labeled
 *        with their WarnCell region name + state instead.
 *
 * Routes:
 *   GET /api/alerts → {generatedAt, sources:{...}, count, alerts:[...]}
 *
 * Shared shape: {id, source:'nws'|'dwd', event, headline, description,
 * severity, certainty, urgency, effective, expires, area}. Sorted most-severe
 * first. Per-source failures are recorded honestly in `sources.<key>.error`;
 * a 502 is returned only when EVERY source fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 */

const NWS_URL = 'https://api.weather.gov/alerts/active?status=actual';
const DWD_URL = 'https://www.dwd.de/DWD/warnungen/warnapp/json/warnings.json';

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const DESCRIPTION_CAP = 2_000;
const USER_AGENT = 'Gods Eye View (public weather-alert aggregation)';

const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1 };

// DWD warnapp level → label (level 1 yellow → 4 dark red).
// Mapping is INFERRED from DWD's public warn-level documentation, not from
// a labeled field in the feed itself.
const DWD_LEVEL_LABEL = {
  1: 'Minor',
  2: 'Moderate',
  3: 'Severe',
  4: 'Extreme',
};

let cache = null; // {at, payload}
let inflight = null;

async function fetchTextCapped(sourceKey, url, accept) {
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
    if (!response.ok)
      throw Object.assign(
        new Error(`alerts_${sourceKey}_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`alerts_${sourceKey}_upstream_too_large`), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function capDescription(value) {
  const s = String(value ?? '');
  return s.length > DESCRIPTION_CAP ? s.slice(0, DESCRIPTION_CAP) + '…' : s;
}

function msToIso(ms) {
  const n = Number(ms);
  return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

// ——— NWS parsing (pure, exported for tests) ———

function trimNwsAlert(feature) {
  const p = feature?.properties ?? {};
  const id = String(feature?.id ?? p.id ?? '');
  if (!id) return null;
  return {
    id: `nws:${id}`,
    source: 'nws',
    event: String(p.event ?? ''),
    headline: String(p.headline ?? ''),
    description: capDescription(p.description),
    severity: String(p.severity ?? 'Unknown'),
    certainty: p.certainty ?? null,
    urgency: p.urgency ?? null,
    effective: p.effective ?? null,
    expires: p.expires ?? null,
    area: String(p.areaDesc ?? ''),
  };
}

export function parseNwsAlerts(upstream) {
  const features = Array.isArray(upstream?.features) ? upstream.features : [];
  return features.map(trimNwsAlert).filter((a) => a && a.event);
}

// ——— DWD warnapp parsing (pure, exported for tests) ———

/** Unwrap `warnWetter.loadWarnings({...});` JSONP → parsed object. */
export function parseDwdJsonp(text) {
  const t = String(text ?? '').trim();
  const start = t.indexOf('(');
  const end = t.lastIndexOf(')');
  if (start < 0 || end <= start)
    throw new Error('alerts_dwd_jsonp_unwrap_failed');
  return JSON.parse(t.slice(start + 1, end));
}

function trimDwdWarning(w, areaID, preliminary) {
  const start = Number(w?.start);
  if (!Number.isFinite(start)) return null;
  const level = Number(w?.level);
  const severity = DWD_LEVEL_LABEL[level] ?? 'Unknown';
  const regionName = String(w?.regionName ?? '');
  const state = String(w?.state ?? '');
  const eventEn =
    w?.i18nTitle && typeof w.i18nTitle === 'object'
      ? String(w.i18nTitle.en ?? '')
      : '';
  return {
    id: `dwd:${areaID}:${start}`,
    source: 'dwd',
    event: eventEn || String(w?.event ?? ''),
    eventDe: String(w?.event ?? ''),
    headline: String(w?.headline ?? ''),
    description: capDescription(w?.description),
    severity,
    dwdLevel: Number.isFinite(level) ? level : null,
    certainty: null,
    urgency: null,
    effective: msToIso(start),
    expires: msToIso(w?.end),
    area: state ? `${regionName} — ${state}` : regionName,
    areaID: String(areaID ?? ''),
    regionName,
    state,
    preliminary: Boolean(preliminary),
  };
}

export function parseDwdAlerts(payload) {
  const out = [];
  for (const [bucket, preliminary] of [
    ['warnings', false],
    ['vorabInformation', true],
  ]) {
    const groups = payload?.[bucket];
    if (!groups || typeof groups !== 'object') continue;
    for (const [areaID, list] of Object.entries(groups)) {
      if (!Array.isArray(list)) continue;
      for (const w of list) {
        const a = trimDwdWarning(w, areaID, preliminary);
        if (a) out.push(a);
      }
    }
  }
  return out;
}

// ——— source fetchers ———

async function fetchNwsSource() {
  const started = Date.now();
  try {
    const text = await fetchTextCapped('nws', NWS_URL, 'application/geo+json');
    const alerts = parseNwsAlerts(JSON.parse(text));
    return {
      key: 'nws',
      ok: true,
      count: alerts.length,
      attribution: 'US National Weather Service (keyless GeoJSON)',
      latencyMs: Date.now() - started,
      alerts,
    };
  } catch (error) {
    return {
      key: 'nws',
      ok: false,
      count: 0,
      attribution: 'US National Weather Service (keyless GeoJSON)',
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      alerts: [],
    };
  }
}

async function fetchDwdSource() {
  const started = Date.now();
  try {
    const text = await fetchTextCapped(
      'dwd',
      DWD_URL,
      'application/javascript',
    );
    const payload = parseDwdJsonp(text);
    const alerts = parseDwdAlerts(payload);
    const feedTime = msToIso(payload?.time);
    return {
      key: 'dwd',
      ok: true,
      count: alerts.length,
      attribution: 'Deutscher Wetterdienst (DWD) warnapp feed',
      latencyMs: Date.now() - started,
      feedTime,
      copyright: String(payload?.copyright ?? ''),
      alerts,
    };
  } catch (error) {
    return {
      key: 'dwd',
      ok: false,
      count: 0,
      attribution: 'Deutscher Wetterdienst (DWD) warnapp feed',
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      alerts: [],
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const alerts = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
      ...(r.key === 'dwd' && r.ok
        ? { feedTime: r.feedTime ?? null, copyright: r.copyright ?? '' }
        : {}),
    };
    alerts.push(...r.alerts);
  }
  alerts.sort((a, b) => {
    const rank =
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0);
    if (rank !== 0) return rank;
    return String(b.effective ?? '').localeCompare(String(a.effective ?? ''));
  });
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: alerts.length,
    counts: {
      nws: alerts.filter((a) => a.source === 'nws').length,
      dwd: alerts.filter((a) => a.source === 'dwd').length,
    },
    alerts,
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all([fetchNwsSource(), fetchDwdSource()])
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(
            new Error(`alerts_all_upstream_down: ${detail}`),
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

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-6 consolidated weather-alerts proxy. Mirrors the wave5 quakes provider shape. */
export function alertsProxy() {
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
          error: 'alerts_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'alerts',
    configureServer({ middlewares }) {
      middlewares.use('/api/alerts', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/alerts', handler);
    },
  };
}

export const _alertsInternals = {
  parseNwsAlerts,
  parseDwdJsonp,
  parseDwdAlerts,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
