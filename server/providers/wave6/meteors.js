/**
 * Wave 6 — RMOB radio-meteor forward-scatter proxy (keyless).
 *
 * The Radio Meteor Observation Bulletin (RMOB) publishes per-station monthly
 * text files with hourly meteor echo counts (radio reflections off meteor
 * trails), used by the meteor forward-scatter community:
 *
 *   #57 https://www.rmob.org/livedata/live_datas/<Station>_<MMYYYY>rmob.TXT
 *
 * Routes:
 *   GET /api/meteor-stations → {generatedAt, sources:{...}, count, stations:[...]}
 *
 * Each station file is parsed defensively: leading date/time columns
 * (YYYY MM DD HH) anchor a data row, trailing integer fields are the hourly
 * count bins and are rolled up to one count per hour. Per-station failures
 * are recorded honestly in `sources.<key>.error`; a 502 is returned only
 * when EVERY station file fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * NOTE (2026-09-27): rmob.org was unreachable from the build VM (curl 000
 * timeouts — VM-throttled, needs a Worker-side probe). The parser below
 * follows the catalog's documented layout (fixed-width text: hourly meteor
 * counts per station) and is covered by fixture tests. Station list is the
 * catalog's documented station; expand via the SOURCES array once a live
 * probe confirms more stations.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60_000;
const MAX_HOURS = 24 * 40;
const USER_AGENT = 'Gods Eye View (public meteor forward-scatter context)';

const STATIONS = ['Norton']; // per the master catalog's #57 documented URL

function stationFileUrl(station, when = new Date()) {
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = when.getUTCFullYear();
  return `https://www.rmob.org/livedata/live_datas/${station}_${mm}${yyyy}rmob.TXT`;
}

const SOURCES = STATIONS.map((station) => ({
  key: `rmob_${station.toLowerCase()}`,
  station,
  attribution: 'RMOB — Radio Meteor Observation Bulletin (free, attribution)',
}));

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ——— parser (pure, exported for tests) ———

/** Parse one station's monthly TXT. Rows start with YYYY MM DD HH. */
export function parseRmob(station, text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const hourly = [];
  let headerStation = '';
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const m = line.match(/^\s*(\d{4})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\b(.*)$/);
    if (!m) {
      // First non-data line is treated as the header (station identity).
      if (!headerStation) headerStation = line.trim().slice(0, 160);
      continue;
    }
    const [, y, mo, d, h, rest] = m;
    const year = Number(y);
    const month = Number(mo);
    const day = Number(d);
    const hour = Number(h);
    if (year < 1990 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23) continue;
    const bins = (rest.match(/-?\d+/g) ?? []).map(Number).filter(Number.isFinite);
    const count = bins.reduce((sum, n) => sum + n, 0);
    const time = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
    hourly.push({
      timeISO: time.toISOString(),
      count,
      bins: bins.length,
    });
  }
  hourly.sort((a, b) => a.timeISO.localeCompare(b.timeISO));
  const trimmed = hourly.slice(-MAX_HOURS);
  return {
    station: headerStation || station,
    code: station,
    count: trimmed.length,
    totalCount: trimmed.reduce((sum, h) => sum + h.count, 0),
    hourly: trimmed,
  };
}

// ——— fetching ———

async function fetchTextCapped(stationKey, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). rmob.org was VM-throttled
      // at build time, so follow is the safe edge default.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, */*' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`meteors_${stationKey}_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`meteors_${stationKey}_upstream_too_large`), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const url = stationFileUrl(source.station);
    const text = await fetchTextCapped(source.key, url);
    const station = parseRmob(source.station, text);
    if (station.count === 0)
      throw Object.assign(new Error(`meteors_${source.key}_no_data`), { status: 502 });
    return {
      key: source.key,
      ok: true,
      count: station.count,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      station,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      station: null,
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
    if (r.station) stations.push(r.station);
  }
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: stations.length,
    stations,
    source: 'RMOB — Radio Meteor Observation Bulletin (radio forward-scatter, keyless)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(SOURCES.map(fetchOneSource))
      .then((results) => {
        const ok = results.some((r) => r.ok);
        if (!ok) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`meteors_all_upstream_down: ${detail}`), { status: 502 });
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

function sendJson(res, status, body, cacheControl = 'public, max-age=3600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the RMOB meteor forward-scatter proxy. Mirrors the felt provider shape. */
export function meteorsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'meteors_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'meteor-stations',
    configureServer({ middlewares }) {
      middlewares.use('/api/meteor-stations', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/meteor-stations', handler);
    },
  };
}

export const _meteorsInternals = {
  parseRmob,
  stationFileUrl,
  buildSnapshot,
  clearCaches: () => { cache = null; inflight = null; },
};
