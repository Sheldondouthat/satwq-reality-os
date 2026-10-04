/**
 * Wave 6 — upcoming-launch aggregation proxy (keyless).
 *
 * Merges two free launch schedules into one upcoming-launch snapshot:
 *
 *   #76 Launch Library 2  https://ll.thespacedevs.com/2.2.0/launch/upcoming/
 *   #77 RocketLaunch.Live  https://fdo.rocketlaunch.live/json/launches/next/5
 *
 * Routes:
 *   GET /api/launches → {generatedAt, sources:{...}, count, launches:[...]}
 *
 * Each source is parsed into the shared shape
 * {id, name, net, windowEnd, status, vehicle, provider, pad, location,
 *  mission, url, lat, lon, sources:[keys]}. LL2 pad coordinates are carried
 * through (RLL rows usually lack them → null, honestly). The two catalogs use different ID spaces
 * (LL2 UUIDs, RLL integers), so cross-source duplicates are merged by
 * normalized name + NET proximity instead. Per-source failures are recorded
 * honestly in `sources.<key>.error`; a 502 is returned only when BOTH
 * sources fail.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * NOTE (2026-09-27): both upstreams were unreachable from the build VM
 * (curl 000 timeouts — VM-throttled, needs a Worker-side probe). Parsers
 * below follow each provider's documented response shape and are covered by
 * fixture tests.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;
const MAX_LAUNCHES = 60;
const USER_AGENT = 'Gods Eye View (public launch aggregation)';

// Same physical launch reported by both catalogs.
const DEDUPE_TIME_MS = 6 * 3_600_000;

const SOURCES = [
  {
    key: 'll2',
    url: 'https://ll.thespacedevs.com/2.2.0/launch/upcoming/?limit=40&hide_club_events=true',
    parse: parseLl2,
    attribution: 'TheSpaceDevs Launch Library 2 (free, attribution)',
  },
  {
    key: 'rll',
    url: 'https://fdo.rocketlaunch.live/json/launches/next/10',
    parse: parseRll,
    attribution: 'RocketLaunch.Live (free)',
  },
];

let cache = null; // {at, payload}
let inflight = null;

function str(value, maxLen) {
  return value == null ? '' : String(value).slice(0, maxLen);
}

/** Null-safe finite number: null/''/non-numeric stay null (never Number(null)===0). */
function numOrNull(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const MONTH_INDEX = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/**
 * Parse month-granularity NET strings ("NET Oct 2026", "Oct 2026") to UTC
 * midnight of the 1st. TZ-independent by construction (Date.UTC).
 * Returns null when the string is not month-granularity.
 */
export function parseMonthYearNet(value) {
  const m = /^(?:net\s+)?([a-z]{3,9})\s+(\d{4})$/i.exec(
    String(value ?? '').trim(),
  );
  if (!m) return null;
  const mi = MONTH_INDEX[m[1].slice(0, 3).toLowerCase()];
  if (mi == null) return null;
  return new Date(Date.UTC(Number(m[2]), mi, 1)).toISOString();
}

/** Parse a NET value: month-granularity first (deterministic), then Date.parse. */
function parseNet(value) {
  if (value == null || value === '') return null;
  return (
    parseMonthYearNet(value) ??
    (() => {
      const t = Date.parse(String(value));
      return Number.isFinite(t) ? new Date(t).toISOString() : null;
    })()
  );
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/** Normalized launch name for cross-catalog matching. */
function normalizeName(name) {
  return str(name, 200)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLaunch({
  id,
  name,
  net,
  windowEnd,
  status,
  vehicle,
  provider,
  pad,
  location,
  mission,
  url,
  lat,
  lon,
  source,
}) {
  if (!id || !name) return null;
  return {
    id: str(id, 120),
    name: str(name, 200),
    net: parseNet(net),
    windowEnd: isoOrNull(windowEnd),
    status: str(status, 60),
    vehicle: str(vehicle, 120),
    provider: str(provider, 120),
    pad: str(pad, 160),
    location: str(location, 160),
    mission: str(mission, 400),
    url: str(url, 300),
    lat: numOrNull(lat),
    lon: numOrNull(lon),
    sources: [source],
  };
}

/**
 * Merge launches that describe the same physical flight across catalogs:
 * normalized names equal AND |Δnet| ≤ 6 h. The merged entry prefers LL2's
 * richer fields when the non-key fields disagree, and unions source keys.
 */
function dedupeLaunches(launches) {
  const ordered = [...launches].sort((a, b) => {
    const ta = a.net ? Date.parse(a.net) : Number.POSITIVE_INFINITY;
    const tb = b.net ? Date.parse(b.net) : Number.POSITIVE_INFINITY;
    return ta - tb;
  });
  const merged = [];
  for (const l of ordered) {
    const lName = normalizeName(l.name);
    const lTime = l.net ? Date.parse(l.net) : null;
    const hit = merged.find((m) => {
      if (normalizeName(m.name) !== lName || !lName) return false;
      if (lTime == null || m.net == null) return false;
      return Math.abs(Date.parse(m.net) - lTime) <= DEDUPE_TIME_MS;
    });
    if (hit) {
      for (const s of l.sources)
        if (!hit.sources.includes(s)) hit.sources.push(s);
      // Carry coordinates across the merge when the survivor lacks them.
      if (hit.lat == null && l.lat != null) {
        hit.lat = l.lat;
        hit.lon = l.lon;
      }
      // Prefer the report with a longer name/mission blurb (richer fields).
      if ((l.mission ?? '').length > (hit.mission ?? '').length) {
        hit.mission = l.mission;
        hit.status = l.status || hit.status;
        hit.url = l.url || hit.url;
      }
    } else {
      merged.push({ ...l, sources: [...l.sources] });
    }
  }
  return merged.slice(0, MAX_LAUNCHES);
}

// ——— source parsers (all pure, exported for tests) ———

function parseLl2(upstream) {
  const results = Array.isArray(upstream?.results) ? upstream.results : [];
  const out = [];
  for (const r of results) {
    const l = normalizeLaunch({
      id: r?.id ? `ll2:${r.id}` : null,
      name: r?.name,
      net: r?.net ?? r?.window_start,
      windowEnd: r?.window_end,
      status: r?.status?.name,
      vehicle:
        r?.rocket?.configuration?.full_name ?? r?.rocket?.configuration?.name,
      provider: r?.launch_service_provider?.name,
      pad: r?.pad?.name,
      location: r?.pad?.location?.name,
      mission: r?.mission?.description ?? r?.mission?.name,
      url: r?.url,
      lat: r?.pad?.latitude,
      lon: r?.pad?.longitude,
      source: 'll2',
    });
    if (l) out.push(l);
  }
  return out;
}

function parseRll(upstream) {
  const results = Array.isArray(upstream?.result) ? upstream.result : [];
  const out = [];
  for (const r of results) {
    const missions = Array.isArray(r?.missions) ? r.missions : [];
    const l = normalizeLaunch({
      id: r?.id != null ? `rll:${r.id}` : null,
      name: r?.name,
      // RLL carries several date spellings; prefer the precise ones.
      net: r?.t0 ?? r?.date ?? r?.date_str,
      windowEnd: null,
      status: Array.isArray(r?.tags) ? r.tags.join(', ') : null,
      vehicle: r?.vehicle?.name,
      provider: r?.provider?.name,
      pad: r?.location?.name,
      location: r?.location?.name,
      mission:
        missions
          .map((m) => m?.description ?? m?.name)
          .filter(Boolean)
          .join(' — ') || null,
      url: r?.quicktext ?? null,
      lat: r?.pad?.latitude ?? r?.pad?.lat ?? null,
      lon: r?.pad?.longitude ?? r?.pad?.lng ?? r?.pad?.lon ?? null,
      source: 'rll',
    });
    if (l) out.push(l);
  }
  return out;
}

// ——— fetching ———

async function fetchJsonCapped(sourceKey, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). Both launch upstreams
      // were VM-throttled at build time (2026-09-27), so no redirect
      // behaviour was asserted — follow is the safe edge default.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`launches_${sourceKey}_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(
        new Error(`launches_${sourceKey}_upstream_too_large`),
        { status: 502 },
      );
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const upstream = await fetchJsonCapped(source.key, source.url);
    const launches = source.parse(upstream);
    return {
      key: source.key,
      ok: true,
      count: launches.length,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      launches,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      launches: [],
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
    all.push(...r.launches);
  }
  const launches = dedupeLaunches(all);
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: launches.length,
    merged: all.length - launches.length,
    launches,
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
            new Error(`launches_all_upstream_down: ${detail}`),
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

function sendJson(res, status, body, cacheControl = 'public, max-age=1800') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the upcoming-launch aggregation proxy. Mirrors the quakes provider shape. */
export function launchesProxy() {
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
          error: 'launches_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'launches',
    configureServer({ middlewares }) {
      middlewares.use('/api/launches', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/launches', handler);
    },
  };
}

export const _launchesInternals = {
  parseLl2,
  parseRll,
  normalizeLaunch,
  normalizeName,
  dedupeLaunches,
  buildSnapshot,
  parseMonthYearNet,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
