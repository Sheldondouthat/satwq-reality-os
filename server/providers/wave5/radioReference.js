/**
 * Radio-reference proxy (keyless, three on-demand datasets).
 *
 *   GET /api/radio-reference?call=W1AW
 *     US callsign lookup via callook.info (FCC ULS data), trimmed to
 *     {callsign, name, type, licenseClass, address, lat, lon, gridsquare,
 *     expires, source}.
 *   GET /api/radio-reference?tle=1
 *     AMSAT amateur-satellite TLE file (nasa.all), parsed from the text
 *     preamble into {name, line1, line2, noradId} rows. This is a COMPLEMENT
 *     to the existing /api/celestrak layer (general GP data), not a
 *     replacement: AMSAT publishes amateur-radio sats with a contact point
 *     the CelesTrak groups don't always carry.
 *   GET /api/radio-reference?search=UVB-76
 *     numbers-stations.com WordPress REST search — a REFERENCE DATABASE of
 *     numbers-station articles, honestly labeled as such; NOT live telemetry.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident; final response host pinned per
 * dataset — no node: imports, no WASM).
 */

const CALLOOK_URL = (call) => `https://callook.info/${encodeURIComponent(call)}/json`;
const AMSAT_URL = 'https://www.amsat.org/tle/current/nasa.all';
const NUMBERS_URL = (q) =>
  `https://www.numbers-stations.com/wp-json/wp/v2/search?search=${encodeURIComponent(q)}&per_page=10`;
const PINNED_HOSTS = {
  callook: 'callook.info',
  amsat: 'www.amsat.org',
  numbers: 'www.numbers-stations.com',
};
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;
const USER_AGENT = 'Gods Eye View (radio reference context)';

const cache = new Map(); // key -> {at, payload}
const inflight = new Map(); // key -> Promise

function pinHost(responseUrl, pinned) {
  let host = '';
  try { host = new URL(responseUrl).hostname; } catch { /* opaque */ }
  if (host && host !== pinned)
    throw Object.assign(new Error(`radio_reference_redirect_off_host:${host}`), { status: 502 });
}

async function fetchCapped(url, pinned, signal, accept = 'application/json') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok)
      throw Object.assign(new Error(`radio_reference_upstream_${response.status}`), { status: 502 });
    pinHost(response.url, pinned);
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('radio_reference_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function trimCallsign(upstream) {
  const loc = upstream?.location ?? {};
  const addr = upstream?.address ?? {};
  const license = upstream?.license ?? upstream?.licence ?? {};
  const lat = Number.parseFloat(loc.latitude);
  const lon = Number.parseFloat(loc.longitude);
  return {
    callsign: String(upstream?.current?.callsign ?? ''),
    name: String(upstream?.name ?? ''),
    type: String(upstream?.type ?? ''),
    licenseClass: String(upstream?.current?.operClass ?? upstream?.operClass ?? ''),
    trustee: String(upstream?.trustee?.callsign ?? ''),
    address: [addr.line1, addr.line2].filter(Boolean).map(String).join(', '),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    gridsquare: String(loc.gridsquare ?? ''),
    expires: license.expires ? String(license.expires) : null,
    source: 'callook.info — FCC ULS data (keyless lookup, not live telemetry)',
  };
}

/** Parse AMSAT's 3LE text (skips the human-readable preamble) into TLE rows. */
export function parseAmsatTle(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('0 ') || line.length < 3) continue;
    const line1 = lines[i + 1] ?? '';
    const line2 = lines[i + 2] ?? '';
    if (!line1.startsWith('1 ') || !line2.startsWith('2 ')) continue;
    const noradId = Number.parseInt(line1.slice(2, 7), 10);
    rows.push({
      name: line.slice(2).trim(),
      line1: line1.trimEnd(),
      line2: line2.trimEnd(),
      noradId: Number.isFinite(noradId) ? noradId : null,
    });
  }
  return rows;
}

function trimNumbersSearch(upstream) {
  const items = Array.isArray(upstream) ? upstream : [];
  return items
    .filter((it) => it && typeof it === 'object')
    .slice(0, 10)
    .map((it) => ({
      id: Number.isFinite(Number(it.id)) ? Number(it.id) : null,
      title: String(it.title ?? ''),
      url: String(it.url ?? ''),
      type: String(it.type ?? ''),
      subtype: String(it.subtype ?? ''),
    }));
}

async function getCached(key, loader) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.payload;
  if (!inflight.has(key)) {
    inflight.set(key, loader().then((payload) => {
      cache.set(key, { at: Date.now(), payload });
      return payload;
    }).finally(() => { inflight.delete(key); }));
  }
  return inflight.get(key);
}

async function callsignLookup(call) {
  return getCached(`call:${call.toUpperCase()}`, async () => {
    const body = await fetchCapped(CALLOOK_URL(call), PINNED_HOSTS.callook, null);
    const upstream = JSON.parse(body);
    if (String(upstream?.status ?? '').toUpperCase() !== 'VALID')
      throw Object.assign(new Error(`callsign_not_found:${call}`), { status: 404 });
    return {
      generatedAt: new Date().toISOString(),
      ...trimCallsign(upstream),
      honesty: 'FCC license record via Callook — a lookup, not live telemetry.',
    };
  });
}

async function amsatTle() {
  return getCached('amsat:tle', async () => {
    const body = await fetchCapped(AMSAT_URL, PINNED_HOSTS.amsat, null, 'text/plain');
    const rows = parseAmsatTle(body);
    return {
      generatedAt: new Date().toISOString(),
      count: rows.length,
      rows,
      source: 'amsat.org — amateur-satellite element sets (keyless)',
      honesty: 'TLEs for propagation; positions are computed from these, not measured. ' +
        'Complements /api/celestrak (general GP); AMSAT carries amateur-radio sats.',
    };
  });
}

async function numbersSearch(q) {
  return getCached(`numbers:${q.toLowerCase()}`, async () => {
    const body = await fetchCapped(NUMBERS_URL(q), PINNED_HOSTS.numbers, null);
    return {
      generatedAt: new Date().toISOString(),
      query: q,
      count: 0,
      results: [],
      source: 'numbers-stations.com — WordPress REST search (keyless)',
      honesty: 'Reference database of numbers-station articles — NOT live telemetry. ' +
        'There is no public live API for numbers stations.',
      ...(function build() {
        const results = trimNumbersSearch(JSON.parse(body));
        return { count: results.length, results };
      })(),
    };
  });
}

function sendJson(res, status, body, cacheControl = 'public, max-age=900') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

function parseQuery(url) {
  try { return new URL(url, 'http://x').searchParams; } catch { return new URLSearchParams(); }
}

/** Mount the radio-reference proxy. Mirrors the nwsAlerts provider shape. */
export function radioReferenceProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const params = parseQuery(req.url);
      const call = (params.get('call') ?? '').trim().toUpperCase();
      const tle = params.get('tle');
      const search = (params.get('search') ?? '').trim();
      if (call) {
        if (!/^[A-Z0-9/]{3,12}$/.test(call))
          return sendJson(res, 400, { error: 'invalid_callsign' }, 'no-store');
        try {
          return sendJson(res, 200, await callsignLookup(call));
        } catch (error) {
          if (error?.status === 404)
            return sendJson(res, 404, { error: 'callsign_not_found', call }, 'no-store');
          throw error;
        }
      }
      if (tle === '1' || tle === 'true') return sendJson(res, 200, await amsatTle());
      if (search) return sendJson(res, 200, await numbersSearch(search));
      return sendJson(res, 400, {
        error: 'usage',
        usage: 'GET /api/radio-reference?call=W1AW | ?tle=1 | ?search=UVB-76',
      }, 'no-store');
    } catch (error) {
      sendJson(res, error?.status === 502 ? 502 : 500, {
        error: 'radio_reference_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'radio-reference',
    configureServer({ middlewares }) {
      middlewares.use('/api/radio-reference', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/radio-reference', handler);
    },
  };
}

export const _radioReferenceInternals = {
  trimCallsign,
  parseAmsatTle,
  trimNumbersSearch,
  clearCaches: () => { cache.clear(); inflight.clear(); },
};
