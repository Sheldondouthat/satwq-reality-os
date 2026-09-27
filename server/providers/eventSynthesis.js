/**
 * eventSynthesisProxy — Reality OS F1 (cross-layer event synthesis) + F6
 * (sky anomaly detection), keyless and free-tier.
 *
 * Routes:
 *   GET /api/events     → {incidents:[...], degraded} — SPACE+TIME
 *                          correlations across >=2 keyless sources
 *   GET /api/sky-alerts → {alerts:[...], degraded}    — emergency squawks
 *                          (exact) + holding/go-around heuristics (v1)
 *
 * Keyless sources only:
 *   - NOAA HMS smoke KML (daily file; candidate URLs + selection reused
 *     from ./hmsSmoke.js via hmsSmokeCandidateUrls/pickHmsSmokeCandidate;
 *     KML parsing reused from src/layers/hmsSmoke/records.js)
 *   - USGS earthquakes M4.5+ day GeoJSON (no key)
 *   - NOAA NHC CurrentStorms.json (no key; status parsing reused from
 *     ./cyclones.js via parseCycloneStatus)
 *   - OpenSky /states/all anonymous (rate-limited; 120 s cache, stale-serve)
 *
 * FIRMS-UPGRADE PATH: FIRMS_MAP_KEY is NOT-CONFIGURED in prod, so FIRMS is
 * not a source here. If a FIRMS key becomes available, add a fifth source
 * (hotspot points) in fetchEvents(), normalize to {lat, lon, confidence},
 * and add a `hotspot-near-*` rule to synthesizeIncidents()'s pattern —
 * the correlation skeleton already supports it.
 *
 * Pages-Functions safety: global fetch + ./common/http.js capped readers
 * only. NO node: imports, NO Buffer, NO fs, NO WASM. This module is traced
 * by the Pages esbuild bundle (like every other provider), so it must load
 * in workerd.
 */

import {
  readResponseJsonCapped,
  readResponseTextCapped,
} from './common/http.js';
import { hmsSmokeCandidateUrls, pickHmsSmokeCandidate } from './hmsSmoke.js';
import { parseSmokeKml } from '../../src/layers/hmsSmoke/records.js';
import { parseCycloneStatus } from './cyclones.js';
import {
  buildTrafficDensity,
  detectSkyAlerts,
  normalizeOpenSkyState,
  normalizeQuakeFeature,
  normalizeStorm,
  synthesizeIncidents,
} from '../../src/layers/eventFeed/model.js';

export const EVENTS_ROUTE = '/api/events';
export const SKY_ALERTS_ROUTE = '/api/sky-alerts';

const USGS_QUAKES_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const NHC_STORMS_URL = 'https://www.nhc.noaa.gov/CurrentStorms.json';
const OPENSKY_STATES_URL = 'https://opensky-network.org/api/states/all';

const UA = 'Gods Eye View event-synthesis (keyless F1/F6)';

const SOURCE_IDS = Object.freeze(['hms-smoke', 'usgs-quakes', 'nhc-storms', 'opensky']);

function byteLengthUtf8(text) {
  return new TextEncoder().encode(text).byteLength;
}

function looksLikeKml(text) {
  return (
    typeof text === 'string' &&
    text.length > 0 &&
    /^\s*</.test(text) &&
    /<kml[\s>]/i.test(text)
  );
}

/**
 * Fetch one upstream URL with a hard timeout and a response byte cap.
 * Never throws for HTTP-level problems — returns {ok:false, reason}.
 */
async function fetchCapped(fetchImpl, url, { capBytes, timeoutMs, accept }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'error',
      headers: { Accept: accept, 'User-Agent': UA },
    });
    if (!response.ok) {
      await response.body?.cancel?.().catch(() => {});
      return { ok: false, reason: `http_${response.status}` };
    }
    const text = await readResponseTextCapped(response, capBytes, controller.signal);
    return { ok: true, text };
  } catch (error) {
    if (error?.name === 'AbortError') return { ok: false, reason: 'timeout' };
    if (error?.code === 'RESPONSE_TOO_LARGE')
      return { ok: false, reason: 'response_too_large' };
    return { ok: false, reason: String(error?.message || error).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Source fetchers — each returns {status:'ok', data} or {status:'error', reason}
// ---------------------------------------------------------------------------

async function fetchHmsSmoke(fetchImpl) {
  const attempts = [];
  for (const candidate of hmsSmokeCandidateUrls(new Date())) {
    const res = await fetchCapped(fetchImpl, candidate.url, {
      capBytes: 5 * 1024 * 1024,
      timeoutMs: 20_000,
      accept: 'application/vnd.google-earth.kml+xml,text/xml',
    });
    const attempt = {
      date: candidate.date,
      url: candidate.url,
      ok: res.ok,
      looksLikeKml: res.ok && looksLikeKml(res.text),
      body: res.ok ? res.text : null,
    };
    attempts.push(attempt);
    if (attempt.ok && !attempt.looksLikeKml && res.text) {
      console.warn(
        `[event-synthesis] HMS ${candidate.date} returned non-KML (${byteLengthUtf8(res.text)} bytes)`,
      );
    }
  }
  const picked = pickHmsSmokeCandidate(attempts);
  if (!picked) {
    const reasons = attempts
      .map((a) => `${a.date}:${a.ok ? (a.looksLikeKml ? 'bad-kml' : 'non-kml') : 'fetch-failed'}`)
      .join(',');
    return { status: 'error', reason: `hms_unavailable(${reasons || 'no-candidates'})` };
  }
  try {
    // FEED-DRIFT ADAPTER (2026-09-26, observed live): the real HMS KML names
    // its placemark styles `#Smoke_Light_style` / `#Smoke_Medium_style`
    // (StyleMap ids), but parseSmokeKml() only recognizes the bare
    // `#Smoke_Light|Moderate|Heavy` vocabulary — so it returns 0 polygons on
    // current files. Canonicalize the feed's actual ids to the parser's
    // vocabulary before parsing. HMS's "Medium" IS the middle density class,
    // so Medium → Moderate is a rename, not a reinterpretation. This is a
    // pre-existing repo bug in src/layers/hmsSmoke/records.js (the hmsSmoke
    // frontend layer is affected too) — flagged in INTEGRATION.md; records.js
    // is outside this provider's dirs so the fix lives here as an adapter.
    const canonical = picked.body
      .replace(/#Smoke_Light_(?:style|hl)\b/g, '#Smoke_Light')
      .replace(/#Smoke_Medium_(?:style|hl)\b/g, '#Smoke_Moderate')
      .replace(/#Smoke_Heavy_(?:style|hl)\b/g, '#Smoke_Heavy');
    const polygons = parseSmokeKml(canonical, { maxPolygons: 600 });
    return { status: 'ok', data: polygons, date: picked.date };
  } catch (error) {
    return { status: 'error', reason: `hms_kml_parse_failed:${String(error?.message || error).slice(0, 80)}` };
  }
}

async function fetchUsgsQuakes(fetchImpl) {
  const res = await fetchCapped(fetchImpl, USGS_QUAKES_URL, {
    capBytes: 2 * 1024 * 1024,
    timeoutMs: 15_000,
    accept: 'application/geo+json,application/json',
  });
  if (!res.ok) return { status: 'error', reason: `usgs_unavailable(${res.reason})` };
  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch {
    return { status: 'error', reason: 'usgs_invalid_json' };
  }
  const features = Array.isArray(payload?.features) ? payload.features : [];
  const quakes = [];
  for (const feature of features.slice(0, 500)) {
    const q = normalizeQuakeFeature(feature);
    if (q) quakes.push(q);
  }
  return { status: 'ok', data: quakes };
}

async function fetchNhcStorms(fetchImpl, nowMs) {
  const res = await fetchCapped(fetchImpl, NHC_STORMS_URL, {
    capBytes: 128 * 1024,
    timeoutMs: 15_000,
    accept: 'application/json',
  });
  if (!res.ok) return { status: 'error', reason: `nhc_unavailable(${res.reason})` };
  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch {
    return { status: 'error', reason: 'nhc_invalid_json' };
  }
  try {
    const storms = parseCycloneStatus(payload, nowMs).map(normalizeStorm).filter(Boolean);
    return { status: 'ok', data: storms };
  } catch (error) {
    // Strict NHC validator rejected the payload — degrade honestly rather
    // than inventing storm records.
    return {
      status: 'error',
      reason: `nhc_schema_rejected:${String(error?.message || error).slice(0, 80)}`,
    };
  }
}

async function fetchOpenSkyStates(fetchImpl) {
  const res = await fetchCapped(fetchImpl, OPENSKY_STATES_URL, {
    capBytes: 12 * 1024 * 1024,
    timeoutMs: 20_000,
    accept: 'application/json',
  });
  if (!res.ok) return { status: 'error', reason: `opensky_unavailable(${res.reason})` };
  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch {
    return { status: 'error', reason: 'opensky_invalid_json' };
  }
  const states = Array.isArray(payload?.states) ? payload.states : [];
  const tracks = [];
  for (const vector of states) {
    const t = normalizeOpenSkyState(vector);
    if (t) tracks.push(t);
    if (tracks.length >= 20_000) break;
  }
  return { status: 'ok', data: tracks, epochMs: Number(payload?.time) * 1000 || null };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export function eventSynthesisProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  eventsTtlMs = 300_000,
  skyTtlMs = 120_000,
  historyKept = 4,
} = {}) {
  let eventsCache = null; // {at, payload}
  let eventsFlight = null;
  let skyCache = null;
  let skyFlight = null;
  /** Bounded rolling window of OpenSky snapshots for v1 heuristics. */
  let trackHistory = [];

  async function acquireEvents() {
    const t = now();
    if (eventsCache && t - eventsCache.at < eventsTtlMs) return { ...eventsCache.payload, stale: false };
    if (!eventsFlight) {
      eventsFlight = buildEventsPayload().finally(() => {
        eventsFlight = null;
      });
    }
    try {
      const payload = await eventsFlight;
      eventsCache = { at: now(), payload };
      return { ...payload, stale: false };
    } catch {
      // buildEventsPayload never rejects (per-source degradation), but a
      // bug here must not 500 the route: fall back to stale cache.
      if (eventsCache) return { ...eventsCache.payload, stale: true };
      throw new Error('event_synthesis_unavailable');
    }
  }

  async function buildEventsPayload() {
    const t = now();
    const [hms, quakes, storms, opensky] = await Promise.all([
      fetchHmsSmoke(fetchImpl),
      fetchUsgsQuakes(fetchImpl),
      fetchNhcStorms(fetchImpl, t),
      fetchOpenSkyStates(fetchImpl),
    ]);
    const degradedSources = [];
    const sourceState = (id, result, count) =>
      result.status === 'ok'
        ? { source: id, ok: true, count }
        : (degradedSources.push({ source: id, reason: result.reason }), { source: id, ok: false, count: 0 });

    const smokePolygons = hms.status === 'ok' ? hms.data : [];
    const quakeList = quakes.status === 'ok' ? quakes.data : [];
    const stormList = storms.status === 'ok' ? storms.data : [];
    const trackList = opensky.status === 'ok' ? opensky.data : [];
    const densityCells = trackList.length ? buildTrafficDensity(trackList) : [];

    const incidents = synthesizeIncidents({
      smokePolygons,
      quakes: quakeList,
      storms: stormList,
      densityCells,
      nowMs: t,
    });

    const degraded = degradedSources.length > 0;
    return {
      schemaVersion: 1,
      incidents,
      degraded,
      degradedSources,
      reason: degraded
        ? `partial: ${degradedSources.map((d) => `${d.source} (${d.reason})`).join('; ')}`
        : null,
      sources: [
        sourceState('hms-smoke', hms, smokePolygons.length),
        sourceState('usgs-quakes', quakes, quakeList.length),
        sourceState('nhc-storms', storms, stormList.length),
        sourceState('opensky', opensky, trackList.length),
      ],
      fetchedAt: new Date(t).toISOString(),
    };
  }

  async function acquireSkyAlerts() {
    const t = now();
    if (skyCache && t - skyCache.at < skyTtlMs) return { ...skyCache.payload, stale: false };
    if (!skyFlight) {
      skyFlight = buildSkyPayload().finally(() => {
        skyFlight = null;
      });
    }
    try {
      const payload = await skyFlight;
      skyCache = { at: now(), payload };
      return { ...payload, stale: false };
    } catch {
      if (skyCache) return { ...skyCache.payload, stale: true };
      throw new Error('sky_alerts_unavailable');
    }
  }

  async function buildSkyPayload() {
    const t = now();
    const opensky = await fetchOpenSkyStates(fetchImpl);
    const tracks = opensky.status === 'ok' ? opensky.data : [];
    if (opensky.status === 'ok' && tracks.length) {
      trackHistory = [...trackHistory, { atMs: t, tracks }].slice(-Math.max(1, historyKept));
    }
    const alerts = detectSkyAlerts(trackHistory, { nowMs: t });
    const degraded = opensky.status !== 'ok';
    return {
      schemaVersion: 1,
      alerts,
      degraded,
      degradedSources: degraded ? [{ source: 'opensky', reason: opensky.reason }] : [],
      reason: degraded ? `opensky (${opensky.reason})` : null,
      fetchedAt: new Date(t).toISOString(),
      windowSec: trackHistory.length
        ? Math.round((trackHistory[trackHistory.length - 1].atMs - trackHistory[0].atMs) / 1000)
        : 0,
      snapshotCount: trackHistory.length,
      trackCount: tracks.length,
    };
  }

  function sendJson(res, status, value) {
    if (res.headersSent) return;
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(value));
  }

  const install = (server) => {
    server.middlewares.use(EVENTS_ROUTE, async (req, res) => {
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (req.url !== '/' && req.url !== '') return sendJson(res, 400, { error: 'invalid_events_query' });
        try {
          sendJson(res, 200, await acquireEvents());
        } catch (error) {
          // Total failure: still 200 with an honest degraded payload —
          // the panel shows a retrying empty state, not a crash.
          sendJson(res, 200, {
            schemaVersion: 1,
            incidents: [],
            degraded: true,
            degradedSources: SOURCE_IDS.map((source) => ({ source, reason: 'unavailable' })),
            reason: String(error?.message || 'event_synthesis_unavailable'),
            sources: SOURCE_IDS.map((source) => ({ source, ok: false, count: 0 })),
            fetchedAt: new Date(now()).toISOString(),
            stale: false,
          });
        }
      } catch {
        sendJson(res, 500, { error: 'event_synthesis_error' });
      }
    });

    server.middlewares.use(SKY_ALERTS_ROUTE, async (req, res) => {
      try {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
        if (req.url !== '/' && req.url !== '') return sendJson(res, 400, { error: 'invalid_sky_alerts_query' });
        try {
          sendJson(res, 200, await acquireSkyAlerts());
        } catch (error) {
          sendJson(res, 200, {
            schemaVersion: 1,
            alerts: [],
            degraded: true,
            degradedSources: [{ source: 'opensky', reason: 'unavailable' }],
            reason: String(error?.message || 'sky_alerts_unavailable'),
            fetchedAt: new Date(now()).toISOString(),
            windowSec: 0,
            snapshotCount: 0,
            trackCount: 0,
            stale: false,
          });
        }
      } catch {
        sendJson(res, 500, { error: 'sky_alerts_error' });
      }
    });
  };

  return {
    name: 'event-synthesis',
    configureServer: install,
    configurePreviewServer: install,
  };
}
