/**
 * Wave 6 — ham-space aggregation proxy: ARISS ISS station status +
 * e-Callisto solar radio spectrograms (all keyless).
 *
 * Two slow/fast-moving sources, quakes-style multi-source shape:
 *
 *   ariss      https://ariss.org/current-status-of-iss-stations.html
 *              Slow-changing HTML of ISS amateur-radio station status
 *              (NA1SS voice, RS0ISS APRS). Scraped into keyword lines +
 *              extracted MHz frequencies; cached 12 h.
 *   ecallisto  https://soleil.i4ds.ch/solarradio/data/2002-20yy_Callisto/YYYY/MM/DD/
 *              Apache directory listing of the current (UTC) day, parsed
 *              as an activity signal: per-station file counts and latest
 *              spectrogram timestamp. FITS payloads are NOT downloaded —
 *              decoding them in a worker is the documented hard path.
 *              Today's listing 404s → yesterday's is tried; cached 15 min.
 *
 * Routes:
 *   GET /api/ham-space → {generatedAt, sources:{...}, ariss:{...}, ecallisto:{...}}
 *
 * Per-source failures are recorded honestly in `sources.<key>.error`; a
 * 502 is returned only when EVERY source fails.
 *
 * NOTE: /api/radio is already taken by the radio-browser station proxy,
 * so this ships as the separate /api/ham-space route.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const ARISS_URL = 'https://ariss.org/current-status-of-iss-stations.html';
const ECALLISTO_BASE = 'https://soleil.i4ds.ch/solarradio/data/2002-20yy_Callisto';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const ARISS_TTL_MS = 12 * 60 * 60_000;
const ECALLISTO_TTL_MS = 15 * 60_000;
const MAX_ARISS_NOTES = 40;
const USER_AGENT = 'Gods Eye View (ham-space radio context)';

/** Tiny per-source TTL + in-flight cache (mirrors the wave5 makeCache shape). */
function cachedSource(ttlMs, fetchFn) {
  let slot = null; // {at, payload}
  let flying = null;
  async function get() {
    const now = Date.now();
    if (slot && now - slot.at < ttlMs) return slot.payload;
    if (!flying) {
      flying = fetchFn()
        .then((result) => {
          slot = { at: Date.now(), payload: result };
          return result;
        })
        .finally(() => {
          flying = null;
        });
    }
    return flying;
  }
  function clear() {
    slot = null;
    flying = null;
  }
  return { get, clear };
}

const arissCached = cachedSource(ARISS_TTL_MS, fetchAriss);
const ecallistoCached = cachedSource(ECALLISTO_TTL_MS, fetchEcallisto);

async function fetchTextCapped(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html, */*' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`${label}_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`${label}_upstream_too_large`), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

const ARISS_KEYWORDS = /NA1SS|RS0ISS|MHz|kHz|APRS|packet|voice|cross-?band|SSTV|repeater|digipeat/i;

/** Strip HTML to text, then keep text chunks carrying ham-radio keywords. */
export function trimArissPage(html, url) {
  const text = String(html ?? '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chunks = text.split(/(?<=\.)\s+|\s*[•|]\s*/);
  const notes = [];
  for (const chunk of chunks) {
    const c = chunk.trim();
    if (c.length > 12 && ARISS_KEYWORDS.test(c)) notes.push(c.slice(0, 300));
    if (notes.length >= MAX_ARISS_NOTES) break;
  }
  const frequencies = [...new Set(
    [...text.matchAll(/(\d{2,4}\.\d{1,4})\s*MHz/gi)].map((m) => m[1]),
  )].slice(0, 20);
  const title = (String(html ?? '').match(/<title>([^<]*)<\/title>/i)?.[1] ?? 'ARISS ISS station status').trim();
  return {
    title,
    frequencies,
    notes,
    note: 'ARISS ISS amateur-radio station status (slow-changing HTML; lines carrying callsign/frequency keywords).',
  };
}

function utcDayParts(date) {
  return {
    y: date.getUTCFullYear(),
    m: String(date.getUTCMonth() + 1).padStart(2, '0'),
    d: String(date.getUTCDate()).padStart(2, '0'),
  };
}

export function ecallistoDayUrl(date) {
  const { y, m, d } = utcDayParts(date);
  return { day: `${y}-${m}-${d}`, url: `${ECALLISTO_BASE}/${y}/${m}/${d}/` };
}

/**
 * e-Callisto spectrogram files are named <STATION>_<YYYYMMDD>_<HHMMSS>_<NN>.fit[.gz].
 * The Apache listing is parsed as an activity signal: per-station file
 * counts plus the latest timestamp, no FITS download.
 */
export function trimEcallistoListing(html, url, day) {
  const hrefs = [...String(html ?? '').matchAll(/href="([^"]+)"/gi)].map((m) => m[1]);
  const stations = new Map();
  let totalFiles = 0;
  for (const href of hrefs) {
    const file = href.split('/').pop() ?? '';
    const m = file.match(/^([A-Za-z0-9]+)_(\d{8})_(\d{6})_\d+\.fit/i);
    if (!m) continue;
    totalFiles += 1;
    const station = m[1].toUpperCase();
    const stamp = `${m[2].slice(0, 4)}-${m[2].slice(4, 6)}-${m[2].slice(6, 8)}T${m[3].slice(0, 2)}:${m[3].slice(2, 4)}:${m[3].slice(4, 6)}Z`;
    const cur = stations.get(station);
    if (!cur) {
      stations.set(station, { station, files: 1, latest: stamp });
    } else {
      cur.files += 1;
      if (stamp > cur.latest) cur.latest = stamp;
    }
  }
  return {
    day,
    url,
    stationCount: stations.size,
    totalFiles,
    stations: [...stations.values()].sort((a, b) => b.files - a.files),
    note: 'e-Callisto solar radio spectrograms: Apache listing parsed as activity signal; FITS payloads not downloaded.',
  };
}

async function fetchAriss() {
  const started = Date.now();
  try {
    const html = await fetchTextCapped(ARISS_URL, 'ariss');
    return {
      key: 'ariss', ok: true, latencyMs: Date.now() - started,
      attribution: 'ARISS (amateur radio on the ISS)',
      data: trimArissPage(html, ARISS_URL),
    };
  } catch (error) {
    return {
      key: 'ariss', ok: false, latencyMs: Date.now() - started,
      attribution: 'ARISS (amateur radio on the ISS)',
      error: error?.message ?? 'unknown',
    };
  }
}

async function fetchEcallisto() {
  const started = Date.now();
  try {
    // Try today's UTC listing, then yesterday's (tomorrow's data cannot exist).
    const attempts = [ecallistoDayUrl(new Date()), ecallistoDayUrl(new Date(Date.now() - 86_400_000))];
    let lastError = null;
    for (const { day, url } of attempts) {
      try {
        const html = await fetchTextCapped(url, 'ecallisto');
        return {
          key: 'ecallisto', ok: true, latencyMs: Date.now() - started,
          attribution: 'e-Callisto / FHNW (solar radio spectrograms)',
          data: trimEcallistoListing(html, url, day),
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error('ecallisto_no_listing');
  } catch (error) {
    return {
      key: 'ecallisto', ok: false, latencyMs: Date.now() - started,
      attribution: 'e-Callisto / FHNW (solar radio spectrograms)',
      error: error?.message ?? 'unknown',
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const payload = { generatedAt: new Date().toISOString() };
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    if (r.ok) payload[r.key] = r.data;
  }
  return { ...payload, sources };
}

async function getSnapshot() {
  const [ariss, ecallisto] = await Promise.all([arissCached.get(), ecallistoCached.get()]);
  if (!ariss.ok && !ecallisto.ok) {
    throw Object.assign(
      new Error(`hamspace_all_upstream_down: ariss:${ariss.error}; ecallisto:${ecallisto.error}`),
      { status: 502 },
    );
  }
  return buildSnapshot([ariss, ecallisto]);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=900') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the ham-space aggregation proxy. Mirrors the quakes provider shape. */
export function hamSpaceProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'hamspace_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'ham-space',
    configureServer({ middlewares }) {
      middlewares.use('/api/ham-space', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ham-space', handler);
    },
  };
}

export const _hamSpaceInternals = {
  trimArissPage,
  trimEcallistoListing,
  ecallistoDayUrl,
  buildSnapshot,
  fetchAriss,
  fetchEcallisto,
  clearCaches: () => { arissCached.clear(); ecallistoCached.clear(); },
};
