/**
 * Interplanetary positions proxy (keyless) — /api/interplanetary.
 *
 * Live heliocentric positions of active deep-space missions via the JPL
 * Horizons API (public, keyless, free):
 *   https://ssd.jpl.nasa.gov/api/horizons.api
 *
 * Verified live 2026-09-27: HTTP 200, {"result": "..."} with a VECTOR table
 * between $$SOE / $$EOE markers.
 *
 * One Horizons request per craft (the API takes a single COMMAND per call),
 * fanned out server-side in parallel, cached in-memory 1 h. Positions are
 * solar-system-barycentric ecliptic J2000 km — the frontend plots them on a
 * dedicated log-scale "beyond" view, never distorting the Earth globe.
 *
 * Pages-safe: this module imports NOTHING (plain global fetch + JSON only),
 * no node: imports, no WASM, no fs.
 */

const HORIZONS_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api';
const USER_AGENT = 'satwq-reality-os (public Horizons context)';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 512 * 1024;
const CACHE_TTL_MS = 60 * 60 * 1000;
const AU_KM = 149597870.7;

/** Horizons spacecraft COMMAND ids (JPL Horizons manual, major-body/spacecraft list). */
const CRAFT = [
  {
    id: 'vgr1',
    name: 'Voyager 1',
    command: '-31',
    blurb: 'Interstellar mission — most distant human-made object',
  },
  {
    id: 'vgr2',
    name: 'Voyager 2',
    command: '-32',
    blurb: 'Interstellar mission — only craft to visit all four outer planets',
  },
  {
    id: 'psp',
    name: 'Parker Solar Probe',
    command: '-96',
    blurb: 'Closest approach to the Sun of any spacecraft',
  },
  {
    id: 'jwst',
    name: 'JWST',
    command: '-170',
    blurb: 'Halo orbit around Sun–Earth L2',
  },
  {
    id: 'nh',
    name: 'New Horizons',
    command: '-98',
    blurb: 'Kuiper Belt extended mission (post-Arrokoth)',
  },
  {
    id: 'bepi',
    name: 'BepiColombo',
    command: '-121',
    blurb: 'ESA/JAXA Mercury orbiter mission',
  },
];

/**
 * Parse one Horizons VECTOR result block. Returns {x,y,z,vx,vy,vz,lt_s,rg_km}
 * from the FIRST ephemeris record, or null when the table is missing.
 * Exported for unit tests.
 */
export function parseHorizonsVectors(resultText) {
  if (typeof resultText !== 'string') return null;
  const soe = resultText.indexOf('$$SOE');
  const eoe = resultText.indexOf('$$EOE');
  if (soe < 0 || eoe < 0 || eoe <= soe) return null;
  const table = resultText.slice(soe + 5, eoe);
  const num = (re) => {
    const m = table.match(re);
    return m ? Number(m[1].replace(/D/i, 'E')) : NaN;
  };
  const x = num(/X\s*=\s*([+-]?\d+(?:\.\d+)?(?:[DE][+-]?\d+)?)/);
  const y = num(/Y\s*=\s*([+-]?\d+(?:\.\d+)?(?:[DE][+-]?\d+)?)/);
  const z = num(/Z\s*=\s*([+-]?\d+(?:\.\d+)?(?:[DE][+-]?\d+)?)/);
  const vx = num(/VX\s*=\s*([+-]?\d+(?:\.\d+)?(?:[DE][+-]?\d+)?)/);
  const vy = num(/VY\s*=\s*([+-]?\d+(?:\.\d+)?(?:[DE][+-]?\d+)?)/);
  const vz = num(/VZ\s*=\s*([+-]?\d+(?:\.\d+)?(?:[DE][+-]?\d+)?)/);
  const lt = num(/LT\s*=\s*([+-]?\d+(?:\.\d+)?(?:[DE][+-]?\d+)?)/);
  const rg = num(/RG\s*=\s*([+-]?\d+(?:\.\d+)?(?:[DE][+-]?\d+)?)/);
  if (![x, y, z].every(Number.isFinite)) return null;
  return {
    xKm: x,
    yKm: y,
    zKm: z,
    vxKms: Number.isFinite(vx) ? vx : null,
    vyKms: Number.isFinite(vy) ? vy : null,
    vzKms: Number.isFinite(vz) ? vz : null,
    lightTimeS: Number.isFinite(lt) ? lt : null,
    rangeKm: Number.isFinite(rg) ? rg : null,
  };
}

async function fetchTextCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`interplanetary_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('interplanetary_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function horizonsUrl(command, startDate, stopDate) {
  const url = new URL(HORIZONS_URL);
  url.searchParams.set('format', 'json');
  url.searchParams.set('COMMAND', `'${command}'`);
  url.searchParams.set('EPHEM_TYPE', 'VECTOR');
  url.searchParams.set('CENTER', '@0');
  url.searchParams.set('START_TIME', startDate);
  url.searchParams.set('STOP_TIME', stopDate);
  url.searchParams.set('STEP_SIZE', '1d');
  return url.toString();
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

async function fetchCraft(craft, startDate, stopDate) {
  const text = await fetchTextCapped(
    horizonsUrl(craft.command, startDate, stopDate),
  );
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('interplanetary_bad_upstream_json'), {
      status: 502,
    });
  }
  const vec = parseHorizonsVectors(parsed?.result);
  if (!vec)
    throw Object.assign(new Error('interplanetary_no_ephemeris'), {
      status: 502,
    });
  const rangeKm = vec.rangeKm ?? Math.hypot(vec.xKm, vec.yKm, vec.zKm);
  const speedKms =
    vec.vxKms == null ? null : Math.hypot(vec.vxKms, vec.vyKms, vec.vzKms);
  return {
    id: craft.id,
    name: craft.name,
    blurb: craft.blurb,
    epoch: `${startDate} 00:00 TDB`,
    xKm: vec.xKm,
    yKm: vec.yKm,
    zKm: vec.zKm,
    distAu: rangeKm / AU_KM,
    speedKms,
    lightTimeHrs: vec.lightTimeS == null ? null : vec.lightTimeS / 3600,
    frame: 'solar-system-barycentric ecliptic J2000 (JPL Horizons)',
  };
}

let cache = null; // { at, payload }

async function buildSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  const today = new Date(now);
  const start = ymd(today);
  const stop = ymd(new Date(now + 86400_000));
  const settled = await Promise.allSettled(
    CRAFT.map((craft) => fetchCraft(craft, start, stop)),
  );
  const craft = [];
  const errors = [];
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') craft.push(result.value);
    else
      errors.push({
        id: CRAFT[i].id,
        error: String(result.reason?.message ?? result.reason),
      });
  });
  if (!craft.length)
    throw Object.assign(new Error('interplanetary_all_failed'), {
      status: 502,
    });
  const payload = {
    schemaVersion: 1,
    fetchedAt: new Date(now).toISOString(),
    source: 'JPL Horizons API (keyless)',
    frameNote:
      'Positions are solar-system-barycentric ecliptic J2000 from JPL Horizons. ' +
      'The frontend renders them on a dedicated log-distance view — the Earth globe is never rescaled.',
    craft,
    failed: errors,
  };
  cache = { at: now, payload };
  return payload;
}

function sendJson(res, status, value) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': status === 200 ? 'public, max-age=600' : 'no-store',
  });
  res.end(JSON.stringify(value));
}

/** Mount the interplanetary proxy. Mirrors the vaac/hmsSmoke provider shape. */
export function interplanetaryProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    try {
      sendJson(res, 200, await buildSnapshot());
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'interplanetary_upstream_unavailable',
      });
    }
  }

  return {
    name: 'interplanetary',
    configureServer({ middlewares }) {
      middlewares.use('/api/interplanetary', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/interplanetary', handler);
    },
  };
}
