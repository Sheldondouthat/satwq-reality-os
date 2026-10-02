/**
 * Wave 9 — MIROVA volcano thermal hotspots (INGV NRT latest detections).
 *
 * Upstream: https://www.mirovaweb.it/NRT/ (keyless, server-rendered HTML
 * table; columns: Time (UTC) | ID Volc | Volcano | VRP MW | Distance km |
 * Sensor). The row class (low/moderate/high/very-high/extreme) is MIROVA's
 * own alert level, carried verbatim — never recomputed here.
 *
 * HONESTY: VRP = Volcanic Radiative Power from MODIS/VIIRS middle-infrared,
 * in megawatts — a heat-flux proxy, not lava volume. "Distance km" is the
 * distance from the volcano summit to the detected hotspot pixel. The table
 * is MIROVA's near-real-time LATEST-detections list (one row per volcano per
 * overpass), not a complete volcano inventory: a volcano absent from the
 * list has no current detection above threshold, not "no data". Level
 * thresholds are MIROVA's own (page JS): extreme >10000, very-high >1000,
 * high >100, moderate >10 MW, else low.
 */
const UPSTREAM_URL = 'https://www.mirovaweb.it/NRT/';
const USER_AGENT = 'satyq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const BODY_CAP_BYTES = 2_000_000;
const CACHE_TTL_MS = 30 * 60 * 1000;
const STALE_MS = 7 * 24 * 3600 * 1000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const CACHE_CONTROL = 'public, max-age=900';

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty cell = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse the MIROVA NRT table. Returns { rows } where each row is
 * { time, volcanoId, name, vrpMw, distanceKm, sensor, level }.
 * Rows that do not match the expected 6-cell shape are skipped, never guessed.
 */
export function parseMirova(html) {
  const rows = [];
  const rowRe = /<tr class="([^"]*)">\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td><a[^>]*>([^<]*)<\/a><\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const level = (m[1] || '').trim() || null;
    const name = decodeEntities((m[4] || '').trim());
    const volcanoId = (m[3] || '').trim();
    if (!name || !volcanoId) continue; // never emit a nameless row
    rows.push({
      time: (m[2] || '').trim() || null,
      volcanoId,
      name,
      vrpMw: numOrNull(m[5]),
      distanceKm: numOrNull(m[6]),
      sensor: (m[7] || '').trim() || null,
      level,
    });
  }
  return { rows };
}

export function buildPayload(parsed, stale) {
  const detections = parsed.rows;
  const byLevel = {};
  const bySensor = {};
  const volcanoes = [];
  let maxVrp = null;
  let maxVrpVolcano = null;
  for (const d of detections) {
    if (d.level) byLevel[d.level] = (byLevel[d.level] || 0) + 1;
    if (d.sensor) bySensor[d.sensor] = (bySensor[d.sensor] || 0) + 1;
    if (!volcanoes.includes(d.name)) volcanoes.push(d.name);
    if (d.vrpMw != null && (maxVrp == null || d.vrpMw > maxVrp)) {
      maxVrp = d.vrpMw;
      maxVrpVolcano = d.name;
    }
  }
  return {
    generatedAt: new Date().toISOString(),
    upstream: UPSTREAM_URL,
    stale: !!stale,
    summary: {
      detections: detections.length,
      volcanoes: volcanoes.length,
      byLevel,
      bySensor,
      maxVrpMw: maxVrp,
      maxVrpVolcano,
    },
    detections,
    honesty: {
      vrp: 'Volcanic Radiative Power (MW) from MODIS/VIIRS middle-infrared: a heat-flux proxy, not lava volume.',
      distanceKm: 'Distance from the volcano summit to the detected hotspot pixel.',
      level: "MIROVA's own alert level (row class): extreme >10000, very-high >1000, high >100, moderate >10 MW, else low.",
      latestOnly: 'Near-real-time latest-detections list (one row per volcano per overpass), not a complete volcano inventory.',
      quietIsReal: 'A volcano absent from the list has no current detection above threshold — not missing data.',
      attribution: 'Data: MIROVA (INGV).',
    },
  };
}

// --- fetch machinery (wave9 conventions) ---

async function fetchTextCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html, */*' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`mirova_upstream_${response.status}`), { status: 502 });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('mirova_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(new Error(`mirova_fetch_failed: ${error?.message ?? 'unknown'}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

// --- caches (mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;

async function getPayload() {
  const key = 'all';
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    if (now - docFailedAt < RETRY_COOLDOWN_MS && hit && now - hit.at < STALE_MS) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      try {
        const html = await fetchTextCapped(UPSTREAM_URL, BODY_CAP_BYTES);
        const parsed = parseMirova(html);
        const payload = buildPayload(parsed, false);
        payloadCache.set(key, { at: Date.now(), payload });
        return { payload, stale: false };
      } catch (error) {
        docFailedAt = Date.now();
        if (hit && Date.now() - hit.at < STALE_MS) return { payload: hit.payload, stale: true };
        throw error;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = CACHE_CONTROL) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 MIROVA volcano-hotspot proxy. */
export function mirovaProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const { payload, stale } = await getPayload();
      sendJson(res, 200, stale ? { ...payload, stale: true } : payload);
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'mirova_unavailable',
        detail: error?.message ?? 'unknown',
        honesty: { attribution: 'Data: MIROVA (INGV).' },
      }, 'no-store');
    }
  }

  return {
    name: 'mirova',
    configureServer({ middlewares }) {
      middlewares.use('/api/mirova', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/mirova', handler);
    },
  };
}

export const _mirovaInternals = {
  UPSTREAM_URL,
  CACHE_TTL_MS,
  parseMirova,
  buildPayload,
  decodeEntities,
  numOrNull,
  resetCache: () => { payloadCache.clear(); inflight.clear(); docFailedAt = -Infinity; },
};
