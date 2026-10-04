/**
 * Wave 6 — North American train tracking proxy (all keyless).
 *
 * Aggregates two community Amtrak/VIA trackers into one normalized snapshot:
 *
 *   #160 Amtraker v3   https://api-v3.amtraker.com/v3/trains
 *   #161 TransitDocs    https://asm-backend.transitdocs.com/map
 *
 * Routes:
 *   GET /api/trains → {generatedAt, sources:{...}, count, trains:[...]}
 *
 * Each source is parsed into the shared shape
 * {number, name, route, lat, lon, heading, status, timely, updatedAt, sources:[keys]}
 * and cross-source duplicates are merged by normalized train number
 * (Amtraker and TransitDocs both cover Amtrak; TransitDocs adds VIA).
 * Per-source failures are recorded honestly in `sources.<key>.error`; a 502
 * is returned only when EVERY source fails.
 *
 * amtrak.com itself is bot-walled; community mirrors are the lawful path.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident, no node: imports, no WASM).
 *
 * Reachability note (2026-09-27): both upstreams timed out from the build
 * VM (curl 000 on api-v3.amtraker.com, api.amtraker.com, and
 * asm-backend.transitdocs.com) — marked VM-throttled, needs Worker probe.
 * Parsers below follow the feeds' documented shapes and degrade gracefully
 * on unknown shapes; no redirect behavior could be verified, so no
 * "verified non-redirecting" claim is made.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 60_000;
const MAX_TRAINS = 500;
const USER_AGENT = 'Gods Eye View (public train tracking aggregation)';

const SOURCES = [
  {
    key: 'amtraker',
    url: 'https://api-v3.amtraker.com/v3/trains',
    parse: parseAmtraker,
    attribution: 'Amtraker community API (free, attribution)',
  },
  {
    key: 'transitdocs',
    url: 'https://asm-backend.transitdocs.com/map',
    parse: parseTransitDocs,
    attribution: 'TransitDocs (free public, attribution)',
  },
];

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function clampLatLon(lat, lon) {
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function roundNum(value, decimals = 4) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value, decimals = 4) {
  // NOTE: Number(null) === 0, so nulls must be screened before coercion.
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? roundNum(n, decimals) : null;
}

/** "Acela 2150" → "2150"; "30" → "30"; null when no digits present. */
function normalizeTrainNumber(value) {
  if (value == null) return null;
  const digits = String(value).match(/\d+/g);
  if (!digits) return null;
  return digits.join('').replace(/^0+(?=\d)/, '');
}

function pickString(...candidates) {
  for (const c of candidates) {
    if (c != null && String(c).trim() !== '') return String(c).trim();
  }
  return '';
}

function normalizeTrain({
  number,
  name,
  route,
  lat,
  lon,
  heading,
  status,
  timely,
  updatedAt,
  source,
}) {
  const num = normalizeTrainNumber(number);
  const ll = clampLatLon(Number(lat), Number(lon));
  if (!num || !ll) return null;
  const timeMs =
    updatedAt == null || updatedAt === ''
      ? null
      : updatedAt instanceof Date
        ? updatedAt.getTime()
        : typeof updatedAt === 'number'
          ? updatedAt < 1e12
            ? updatedAt * 1000
            : updatedAt // epoch seconds vs millis
          : Date.parse(updatedAt);
  return {
    number: num,
    name: pickString(name).slice(0, 160),
    route: pickString(route).slice(0, 80),
    lat: roundNum(ll.lat),
    lon: roundNum(ll.lon),
    heading: pickString(heading).slice(0, 24),
    status: pickString(status).slice(0, 120),
    timely:
      timely === true || timely === 'Y' || timely === 'y'
        ? true
        : timely === false || timely === 'N' || timely === 'n'
          ? false
          : null,
    updatedAt: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
    sources: [source],
  };
}

// ——— source parsers (all pure, exported for tests) ———

/**
 * Amtraker v3 `/v3/trains` returns an object keyed by train number whose
 * values are arrays of event reports (newest last in the documented shape).
 * Each report carries trainNum, routName, lat/lon, heading, trainTimely,
 * eventCode/eventName and eventDT ("MM/DD/YYYY HH:MM:SS").
 */
function parseAmtraker(upstream) {
  const out = [];
  const entries = Array.isArray(upstream)
    ? upstream.map((e, i) => [String(e?.trainNum ?? i), e])
    : upstream && typeof upstream === 'object'
      ? Object.entries(upstream)
      : [];
  for (const [key, value] of entries) {
    const reports = Array.isArray(value) ? value : [value];
    const r = reports.filter((x) => x && typeof x === 'object').pop();
    if (!r) continue;
    const t = normalizeTrain({
      number: r.trainNum ?? key,
      name: r.routName,
      route:
        r.route ??
        (r.origCode && r.destCode ? `${r.origCode}-${r.destCode}` : r.route),
      lat: r.lat,
      lon: r.lon,
      heading: r.heading,
      status: r.eventName ?? r.eventCode,
      timely: r.trainTimely,
      updatedAt: r.eventDT,
      source: 'amtraker',
    });
    if (t) out.push(t);
  }
  return out;
}

/**
 * TransitDocs `/map` returns an array of live trains (Amtrak + VIA).
 * Shape is not publicly documented; this parser accepts an array at the
 * root or under .trains/.data/.vehicles and reads each record with
 * generous field-name fallbacks. Unknown fields degrade to ''/null —
 * the record is kept whenever number+coords resolve.
 */
function parseTransitDocs(upstream) {
  const list = Array.isArray(upstream)
    ? upstream
    : Array.isArray(upstream?.trains)
      ? upstream.trains
      : Array.isArray(upstream?.data)
        ? upstream.data
        : Array.isArray(upstream?.vehicles)
          ? upstream.vehicles
          : [];
  const out = [];
  for (const t of list) {
    if (!t || typeof t !== 'object') continue;
    const n = normalizeTrain({
      number: t.train_number ?? t.trainNum ?? t.number ?? t.train_id ?? t.id,
      name: t.route_name ?? t.routName ?? t.name ?? t.line ?? t.operator,
      route: t.route ?? t.route_code ?? t.line_code,
      lat: t.lat ?? t.latitude ?? t.y,
      lon: t.lon ?? t.lng ?? t.longitude ?? t.x,
      heading: t.heading ?? t.bearing ?? t.direction,
      status: t.status ?? t.eventName ?? t.state,
      timely: t.timely ?? t.on_time ?? t.onTime,
      updatedAt: t.updated_at ?? t.updatedAt ?? t.timestamp ?? t.last_update,
      source: 'transitdocs',
    });
    if (n) out.push(n);
  }
  return out;
}

/**
 * Merge records describing the same physical train across trackers:
 * normalized train number is the join key (Amtrak numbers are unique
 * per day; VIA uses its own range, so collisions across operators are
 * rare and harmless at this fidelity). The merged entry keeps the fields
 * of the first source listed (Amtraker) and unions the source keys.
 */
function dedupeTrains(trains) {
  const byNumber = new Map();
  for (const t of trains) {
    const hit = byNumber.get(t.number);
    if (hit) {
      for (const s of t.sources)
        if (!hit.sources.includes(s)) hit.sources.push(s);
      // Prefer records with a fresher update time for position fields.
      const hitT = hit.updatedAt ? Date.parse(hit.updatedAt) : -Infinity;
      const tT = t.updatedAt ? Date.parse(t.updatedAt) : -Infinity;
      if (tT > hitT) {
        hit.lat = t.lat;
        hit.lon = t.lon;
        hit.heading = t.heading || hit.heading;
        hit.status = t.status || hit.status;
        hit.updatedAt = t.updatedAt;
      }
      hit.name = hit.name || t.name;
      hit.route = hit.route || t.route;
      if (hit.timely == null) hit.timely = t.timely;
    } else {
      byNumber.set(t.number, { ...t, sources: [...t.sources] });
    }
  }
  return [...byNumber.values()]
    .sort((a, b) =>
      a.number.localeCompare(b.number, undefined, { numeric: true }),
    )
    .slice(0, MAX_TRAINS);
}

// ——— fetching ———

async function fetchJsonCapped(sourceKey, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). Neither train upstream
      // was reachable from the build VM, so no redirect claim is made here.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`trains_${sourceKey}_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`trains_${sourceKey}_upstream_too_large`), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const upstream = await fetchJsonCapped(source.key, source.url);
    const trains = source.parse(upstream);
    return {
      key: source.key,
      ok: true,
      count: trains.length,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      trains,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      trains: [],
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const all = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    all.push(...r.trains);
  }
  const trains = dedupeTrains(all);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: trains.length,
    merged: all.length - trains.length,
    trains,
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
          throw Object.assign(
            new Error(`trains_all_upstream_down: ${detail}`),
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

function sendJson(res, status, body, cacheControl = 'public, max-age=60') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-6 train tracking aggregation proxy. Mirrors the quakes provider shape. */
export function trainsProxy() {
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
          error: 'trains_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'trains',
    configureServer({ middlewares }) {
      middlewares.use('/api/trains', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/trains', handler);
    },
  };
}

export const _trainsInternals = {
  parseAmtraker,
  parseTransitDocs,
  normalizeTrain,
  normalizeTrainNumber,
  dedupeTrains,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
