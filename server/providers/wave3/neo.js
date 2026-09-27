/**
 * Planetary defense board proxy (keyless) — /api/neo.
 *
 * Near-Earth asteroid close approaches for the coming week via NASA/JPL's
 * Close-Approach Data API (public, keyless, free):
 *   https://ssd-api.jpl.nasa.gov/cad.api
 *
 * Verified live 2026-09-27: HTTP 200, {signature, count, fields, data} with
 * fields [des, orbit_id, jd, cd, dist, dist_min, dist_max, v_rel, v_inf,
 * t_sigma_f, h, fullname]; 12 approaches in a 7-day window at dist-max 0.05 AU.
 *
 * Physics honesty: the API publishes absolute magnitude H, NOT diameter.
 * Diameter is estimated from H with an assumed albedo range (0.05–0.25,
 * typical for NEOs) via D(km) = 1329/sqrt(p) · 10^(−H/5) — reported as a
 * range and explicitly labeled "estimated". Miss distance is reported in
 * lunar distances (1 LD = 384,400 km).
 *
 * Pages-safe: this module imports NOTHING (plain global fetch + JSON only),
 * no node: imports, no WASM, no fs.
 */

const CAD_URL = 'https://ssd-api.jpl.nasa.gov/cad.api';
const USER_AGENT = 'satwq-reality-os (public CNEOS context)';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 6 * 3600 * 1000;
const LD_KM = 384400;
const AU_KM = 149597870.7;
const DIST_MAX_AU = 0.05;
const WINDOW_DAYS = 7;
const ROW_CAP = 60;

/**
 * Estimated diameter range (meters) from absolute magnitude H, assuming
 * geometric albedo in [0.05, 0.25]. Returns null when H is not finite.
 * D(km) = 1329 / sqrt(p) * 10^(-H/5). Exported for unit tests.
 */
export function diameterRangeM(h) {
  if (!Number.isFinite(h)) return null;
  const forAlbedo = (p) => (1329 / Math.sqrt(p)) * Math.pow(10, -h / 5) * 1000;
  const hi = forAlbedo(0.05); // dark → larger for same brightness
  const lo = forAlbedo(0.25); // bright → smaller
  return { loM: lo, hiM: hi, albedoAssumed: [0.05, 0.25] };
}

/** Miss distance in lunar distances. Exported for unit tests. */
export function auToLunarDistances(distAu) {
  if (!Number.isFinite(distAu)) return null;
  return (distAu * AU_KM) / LD_KM;
}

/**
 * Transform one cad.api data row into the board's record shape.
 * `fields` is the API's field-name array. Exported for unit tests.
 */
export function transformCadRow(fields, row) {
  const get = (name) => {
    const i = fields.indexOf(name);
    return i >= 0 ? row[i] : null;
  };
  const num = (name) => {
    const raw = get(name);
    if (raw == null || (typeof raw === 'string' && raw.trim() === '')) return null;
    const v = Number(raw);
    return Number.isFinite(v) ? v : null;
  };
  const distAu = num('dist');
  const h = num('h');
  const cd = get('cd');
  return {
    des: String(get('des') ?? '').trim(),
    name: String(get('fullname') ?? '').trim() || String(get('des') ?? '').trim(),
    closeApproachUtc: typeof cd === 'string' ? cd.trim() : null,
    distAu,
    distLd: auToLunarDistances(distAu),
    distMinLd: auToLunarDistances(num('dist_min')),
    distMaxLd: auToLunarDistances(num('dist_max')),
    vRelKms: num('v_rel'),
    absMagH: h,
    diameterEstM: diameterRangeM(h),
    diameterNote: h == null
      ? 'no absolute magnitude published — diameter not estimable'
      : 'ESTIMATED from absolute magnitude H assuming albedo 0.05–0.25 (albedo unknown)',
  };
}

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok)
      throw Object.assign(new Error(`neo_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('neo_upstream_too_large'), { status: 502 });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

let cache = null; // { at, payload }

async function buildSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  const dateMin = ymd(new Date(now));
  const dateMax = ymd(new Date(now + WINDOW_DAYS * 86400_000));
  const url = new URL(CAD_URL);
  url.searchParams.set('date-min', dateMin);
  url.searchParams.set('date-max', dateMax);
  url.searchParams.set('dist-max', String(DIST_MAX_AU));
  url.searchParams.set('sort', 'dist');
  url.searchParams.set('fullname', 'true');
  const body = await fetchJsonCapped(url.toString());
  const fields = Array.isArray(body?.fields) ? body.fields : [];
  const rows = Array.isArray(body?.data) ? body.data : [];
  const approaches = rows
    .slice(0, ROW_CAP)
    .map((row) => transformCadRow(fields, row))
    .filter((r) => r.distLd != null);
  const payload = {
    schemaVersion: 1,
    fetchedAt: new Date(now).toISOString(),
    source: 'NASA/JPL CNEOS Close-Approach Data API (keyless)',
    window: { from: dateMin, to: dateMax, distMaxAu: DIST_MAX_AU },
    count: approaches.length,
    physicsNotes: [
      'Miss distances are geocentric close-approach distances in lunar distances (1 LD = 384,400 km).',
      'Diameters are ESTIMATED from absolute magnitude H with assumed albedo 0.05–0.25 — the true albedo is unknown, so treat the range as an order-of-magnitude guide, not a measurement.',
    ],
    approaches,
  };
  cache = { at: now, payload };
  return payload;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': status === 200 ? 'public, max-age=1800' : 'no-store',
  });
  res.end(JSON.stringify(value));
}

/** Mount the planetary-defense proxy. Mirrors the vaac/hmsSmoke provider shape. */
export function neoProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      sendJson(res, 200, await buildSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'neo_upstream_unavailable',
      });
    }
  }

  return {
    name: 'neo',
    configureServer({ middlewares }) {
      middlewares.use('/api/neo', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/neo', handler);
    },
  };
}
