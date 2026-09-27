/**
 * FAA Temporary Flight Restriction (TFR) overlay proxy (keyless).
 *
 * The formal FAA NOTAM API needs OAuth — this provider deliberately avoids
 * it and uses only the public TFR web tooling, which serves no CORS
 * headers, so the browser cannot fetch it directly:
 *
 *   GET https://tfr.faa.gov/tfrapi/getTfrList          → JSON list (85 active 2026-09-27)
 *   GET https://tfr.faa.gov/download/detail_6_5701.xml → XNOTAM detail XML
 *       (notam id "6/5701" → "6_5701"; verified live 2026-09-27)
 *
 * Detail geometry lives in <abdMergedArea>/<Avx> vertices with
 * <geoLat>44.6666659N</geoLat>/<geoLong>118.59166667W</geoLong> pairs
 * (decimal degrees + hemisphere letter; GRC = great-circle vertex).
 * Altitude from <aseTFRArea> valDistVerUpper/Lower (FT MSL).
 *
 * Routes:
 *   GET /api/tfrs → {generatedAt, count, withGeometry, tfrs:[...]}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd does NOT implement redirect:'error'
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 * Detail fetches are concurrency-capped; one failing TFR degrades that TFR
 * to a geometry-less entry, never the whole payload.
 */

const LIST_URL = 'https://tfr.faa.gov/tfrapi/getTfrList';
const detailUrl = (notamId) =>
  `https://tfr.faa.gov/download/detail_${String(notamId).replace(/\//g, '_')}.xml`;

const LIST_TIMEOUT_MS = 20_000;
const DETAIL_TIMEOUT_MS = 15_000;
const LIST_CAP_BYTES = 1 * 1024 * 1024;
const DETAIL_CAP_BYTES = 256 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const DETAIL_CONCURRENCY = 6;
// Cloudflare Workers free plan allows 50 subrequests per invocation. One list
// fetch + DETAIL_LIMIT detail fetches must stay under it, so geometry coverage
// is deliberately partial: entries past the cap keep null detail (no rings)
// and are still listed. 1 + 40 = 41 < 50.
const DETAIL_LIMIT = 40;
const USER_AGENT = 'Gods Eye View (public TFR context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchTextCapped(url, { timeoutMs, capBytes, accept }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok)
      throw Object.assign(new Error(`tfr_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('tfr_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

/** "44.6666659N" → 44.6666659 ; "118.59166667W" → -118.59166667. */
export function parseDmsHemisphere(raw) {
  if (typeof raw !== 'string') return null;
  const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*([NSEW])$/i);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const sign = m[2].toUpperCase() === 'S' || m[2].toUpperCase() === 'W' ? -1 : 1;
  return sign * value;
}

/** Extract <abdMergedArea> vertex rings: [[lon,lat],...] each. */
export function extractTfrPolygons(detailXml) {
  const rings = [];
  const areaRe = /<abdMergedArea>([\s\S]*?)<\/abdMergedArea>/g;
  let area;
  while ((area = areaRe.exec(detailXml))) {
    const ring = [];
    const vRe =
      /<Avx>[\s\S]*?<geoLat>([^<]+)<\/geoLat>[\s\S]*?<geoLong>([^<]+)<\/geoLong>[\s\S]*?<\/Avx>/g;
    let v;
    while ((v = vRe.exec(area[1]))) {
      const lat = parseDmsHemisphere(v[1]);
      const lon = parseDmsHemisphere(v[2]);
      if (lat === null || lon === null) continue;
      ring.push([lon, lat]);
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

/** Extract per-area name + altitude band from <aseTFRArea> blocks. */
export function extractTfrAreas(detailXml) {
  const areas = [];
  const areaRe = /<aseTFRArea>([\s\S]*?)<\/aseTFRArea>/g;
  let m;
  while ((m = areaRe.exec(detailXml))) {
    const block = m[1];
    const name = /<txtName>([^<]*)<\/txtName>/.exec(block)?.[1]?.trim() || null;
    const upper = /<valDistVerUpper>([^<]*)<\/valDistVerUpper>/.exec(block)?.[1];
    const lower = /<valDistVerLower>([^<]*)<\/valDistVerLower>/.exec(block)?.[1];
    const upperUom = /<uomDistVerUpper>([^<]*)<\/uomDistVerUpper>/.exec(block)?.[1];
    areas.push({
      name,
      upperFt: upperUom === 'FT' && Number.isFinite(Number(upper)) ? Number(upper) : null,
      lowerFt: Number.isFinite(Number(lower)) ? Number(lower) : null,
    });
  }
  return areas;
}

/** Merge list entry + parsed detail into the globe-ready record. */
export function buildTfrRecord(listEntry, detailXml) {
  const areas = detailXml ? extractTfrAreas(detailXml) : [];
  const rings = detailXml ? extractTfrPolygons(detailXml) : [];
  const effective = /<dateEffective>([^<]+)<\/dateEffective>/.exec(detailXml ?? '')?.[1] ?? null;
  const expires = /<dateExpire>([^<]+)<\/dateExpire>/.exec(detailXml ?? '')?.[1] ?? null;
  return {
    id: String(listEntry.notam_id ?? listEntry.gid ?? ''),
    type: String(listEntry.type ?? ''),
    facility: String(listEntry.facility ?? ''),
    state: String(listEntry.state ?? ''),
    description: String(listEntry.description ?? ''),
    effective,
    expires,
    areas,
    rings, // rings of [lon,lat]; GRC arcs rendered as straight segments (documented)
  };
}

async function fetchDetail(notamId) {
  try {
    const xml = await fetchTextCapped(detailUrl(notamId), {
      timeoutMs: DETAIL_TIMEOUT_MS,
      capBytes: DETAIL_CAP_BYTES,
      accept: 'application/xml, text/xml',
    });
    return xml;
  } catch {
    return null; // one dead TFR must not kill the snapshot
  }
}

/** Concurrency-capped detail fan-out. */
async function fetchDetails(notamIds) {
  const results = new Array(notamIds.length).fill(null);
  let cursor = 0;
  const workers = new Array(Math.min(DETAIL_CONCURRENCY, notamIds.length))
    .fill(0)
    .map(async () => {
      while (cursor < notamIds.length) {
        const i = cursor++;
        results[i] = await fetchDetail(notamIds[i]);
      }
    });
  await Promise.all(workers);
  return results;
}

async function loadSnapshot() {
  const raw = await fetchTextCapped(LIST_URL, {
    timeoutMs: LIST_TIMEOUT_MS,
    capBytes: LIST_CAP_BYTES,
    accept: 'application/json',
  });
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('tfr_list_unparseable'), { status: 502 });
  }
  if (!Array.isArray(list))
    throw Object.assign(new Error('tfr_list_unexpected_shape'), { status: 502 });
  const entries = list.filter((e) => e && (e.notam_id || e.gid)).slice(0, 400);
  const detailIds = entries.slice(0, DETAIL_LIMIT).map((e) => e.notam_id ?? e.gid);
  const details = await fetchDetails(detailIds);
  const tfrs = entries.map((entry, i) =>
    buildTfrRecord(entry, i < details.length ? details[i] : null),
  );
  return {
    generatedAt: new Date().toISOString(),
    count: tfrs.length,
    withGeometry: tfrs.filter((t) => t.rings.length > 0).length,
    tfrs,
  };
}

async function getSnapshot() {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = loadSnapshot().then(
      (payload) => {
        cache = { at: Date.now(), payload };
        inflight = null;
        return payload;
      },
      (error) => {
        inflight = null;
        if (cache) return cache.payload; // stale beats empty
        throw error;
      },
    );
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the TFR proxy. Mirrors the nws-alerts/vaac provider shape. */
export function tfrProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    req.on?.('close', () => {});
    try {
      const payload = await getSnapshot();
      sendJson(res, 200, payload, `public, max-age=${Math.floor(CACHE_TTL_MS / 2000)}`);
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        { error: 'tfrs_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    } finally {
      req.removeListener?.('close', () => {});
    }
  }

  return {
    name: 'tfr',
    configureServer({ middlewares }) {
      middlewares.use('/api/tfrs', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/tfrs', handler);
    },
  };
}

export const _tfrInternals = {
  detailUrl,
  fetchDetails,
  loadSnapshot,
  DETAIL_LIMIT,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
