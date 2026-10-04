/**
 * Wave 9 (R2-2) — GOES Earth full-disk imagery liveness provider.
 *
 * Backlog R2-2 ("GOES Earth imagery"): NOAA's public S3 buckets
 * (noaa-goes16/17/18/19) hold ABI Level-2 full-disk products (CMIPF —
 * Cloud and Moisture Imagery Product, Full disk), one file per scan
 * (~10 min cadence) per channel. The bucket LIST API is keyless and
 * reachable (verified live 2026-09-30 from the build VM: 200, XML,
 * real CMIPF keys for G18/G19; G16/G17 return KeyCount 0 — storage
 * birds). The honest, keyless, edge-safe shape is imagery AVAILABILITY:
 * parse the latest scan timestamp out of the object keys (sYYYYDOYHHMMSS),
 * report per-satellite freshness, and hand the UI the NESDIS STAR CDN
 * full-disk GeoColor JPEG URLs (rendered by NOAA — we never render,
 * re-host, or fabricate imagery; the ~3–5 MB NetCDF binaries are never
 * fetched at the edge).
 *
 * HONESTY, stated on the payload:
 *  - CMIPF = Cloud and Moisture Imagery Product, Level-2, full disk —
 *    gridded radiances in NetCDF, NOT a rendered picture. latestScan is
 *    the scan-start timestamp parsed from the S3 object key, not a
 *    measurement we took.
 *  - imageryUrl = NESDIS STAR CDN `ABI/FD/GEOCOLOR/latest.jpg`, a JPEG
 *    rendered by NOAA. We verify it answers (fail-soft HEAD) but do not
 *    proxy its bytes through the worker.
 *  - fresh = latest scan start within 20 min (≈10-min cadence + ~10-min
 *    processing lag); dark = no CMIPF files in the current+previous
 *    UTC-hour window, or latest scan older than 60 min. GOES-16/17
 *    (on-orbit storage) read dark — correctly, from live listings.
 *
 * Upstream (verified live 2026-09-30 from the build VM):
 *   https://noaa-goes{sat}.s3.amazonaws.com/?list-type=2&prefix=ABI-L2-CMIPF/YYYY/DOY/HH/&max-keys=120
 *   → 200, ListBucketResult XML, ~31 KB for a full hour (80 keys at 07:4x).
 * STAR CDN (verified live 2026-09-30):
 *   https://cdn.star.nesdis.noaa.gov/GOES18/ABI/FD/GEOCOLOR/latest.jpg → 200 image/jpeg (9.3 MB)
 *   https://cdn.star.nesdis.noaa.gov/GOES19/ABI/FD/GEOCOLOR/latest.jpg → 200 image/jpeg (9.8 MB)
 *   GOES16 path → 301 → GOES19 (East continuity alias); GOES17 path → 301.
 * Keyless, no signup, no User-Agent requirement (identified UA sent anyway).
 *
 * Routes:
 *   GET /api/goes → { generatedAt, stale, count, requestedNotFound, summary, satellites, attribution }
 * Query: ?sat=G18 (single-satellite lookup; unknown-but-wellformed → 200 + requestedNotFound:true).
 *
 * Pages-safe: global fetch only, capped 256 KB reads, redirect:'follow'
 * (workerd supports only 'follow'/'manual'; 'error' throws at the edge —
 * main 2ec4053), no node: imports, no WASM. ~4–12 subrequests per refresh
 * (LIST per satellite + hour-fallback + fail-soft imagery HEADs) — far
 * under the Workers subrequest headroom rule.
 */

import { readResponseTextCapped } from '../common/http.js';

const USER_AGENT =
  'satwq-reality-os/1.0 (gods-eye-view; GOES Earth-imagery layer; keyless)';
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 256 * 1024; // observed ~31 KB/hr; generous headroom
const CACHE_TTL_MS = 300_000; // CMIPF files land every ~10 min
const RETRY_COOLDOWN_MS = 60_000;
const STALE_MS = 10 * 60_000;
const FRESH_SEC = 1200; // ≤20 min since latest scan start
const DARK_SEC = 3600; // >60 min (or no files) reads dark
const MAX_KEYS = 120; // an hour holds ≤96 CMIPF files (6 scans × 16 ch)
const PRODUCT = 'ABI-L2-CMIPF';

const SATELLITES = [
  {
    sat: 'G16',
    bucket: 'noaa-goes16',
    role: 'GOES East (predecessor) — on-orbit storage',
  },
  { sat: 'G17', bucket: 'noaa-goes17', role: 'On-orbit storage (standby)' },
  { sat: 'G18', bucket: 'noaa-goes18', role: 'GOES West — operational' },
  { sat: 'G19', bucket: 'noaa-goes19', role: 'GOES East — operational' },
];

const SAT_RE = /^G\d{2}$/;

let docCache = null; // {at, rows} — one refresh serves ALL query keys
let docInflight = null;
let docFailedAt = -Infinity;
const payloadCache = new Map();
const PAYLOAD_CACHE_MAX = 32;

/** Number(null)===0 guard: null/NaN upstream numerics become null, never 0. */
function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** S3 prefix for the UTC hour containing ms: ABI-L2-CMIPF/YYYY/DOY/HH/ */
export function hourPrefix(ms) {
  const d = new Date(ms);
  const yyyy = d.getUTCFullYear();
  const startOfYear = Date.UTC(yyyy, 0, 1);
  const doy = String(Math.floor((ms - startOfYear) / 86_400_000) + 1).padStart(
    3,
    '0',
  );
  const hh = String(d.getUTCHours()).padStart(2, '0');
  return `${PRODUCT}/${yyyy}/${doy}/${hh}/`;
}

/**
 * Parse the s-timestamp embedded in a CMIPF object key:
 *   OR_ABI-L2-CMIPF-M6C02_G18_s20262730700205_e20262730709514_c20262730709564.nc
 * Returns { channel, sat, scanStartMs, scanEndMs } or null.
 * Pure. Range-checked — Date.UTC overflow must never silently pass.
 */
export function parseGoesKey(key) {
  if (typeof key !== 'string') return null;
  // S3 keys carry the listing prefix (ABI-L2-CMIPF/2026/273/07/OR_ABI-...);
  // anchor on the OR_ filename, not the string start.
  const m =
    /(?:^|\/)OR_ABI-L2-CMIPF-M6C(\d{2})_G(\d{2})_s(\d{4})(\d{3})(\d{2})(\d{2})(\d{2})\d_e(\d{14})_c(\d{14})\.nc$/.exec(
      key.trim(),
    );
  if (!m) return null;
  const [, ch, sat, yyyy, doy, hh, mm, ss] = m;
  const Y = +yyyy;
  const D = +doy;
  const H = +hh;
  const M = +mm;
  const S = +ss;
  if (Y < 2020 || Y > 2035 || D < 1 || D > 366 || H > 23 || M > 59 || S > 60)
    return null;
  const scanStartMs =
    Date.UTC(Y, 0, 1) +
    (D - 1) * 86_400_000 +
    H * 3_600_000 +
    M * 60_000 +
    S * 1_000;
  if (!Number.isFinite(scanStartMs)) return null;
  return { channel: +ch, sat: `G${sat}`, scanStartMs };
}

/**
 * Parse an S3 ListBucketResult XML doc with anchored regexes (workerd has
 * no DOMParser — dsn.js precedent). Returns { entries, truncated } where
 * entries = [{ key, lastModified, sizeBytes }]. Throws {status:502} when
 * the doc is not a ListBucketResult at all.
 */
export function parseListBucketXml(text) {
  const fail = (msg) =>
    Object.assign(new Error(`goes_invalid_list: ${msg}`), { status: 502 });
  if (typeof text !== 'string' || !text.includes('<ListBucketResult'))
    throw fail('not a ListBucketResult');
  const entries = [];
  const blockRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let block;
  while ((block = blockRe.exec(text)) !== null) {
    const body = block[1];
    const key = /<Key>([^<]*)<\/Key>/.exec(body)?.[1] ?? null;
    const lastModified =
      /<LastModified>([^<]*)<\/LastModified>/.exec(body)?.[1] ?? null;
    const sizeBytes = numOrNull(
      /<Size>([^<]*)<\/Size>/.exec(body)?.[1] ?? null,
    );
    if (key == null) continue;
    entries.push({ key, lastModified, sizeBytes });
  }
  const truncated = /<IsTruncated>\s*true\s*<\/IsTruncated>/.test(text);
  return { entries, truncated };
}

/** Pick the latest parseable CMIPF key. Pure. Returns {entry, parsed, skipped} */
export function selectLatest(entries) {
  let best = null;
  let bestParsed = null;
  let skipped = 0;
  const channels = new Set();
  for (const entry of entries) {
    const parsed = parseGoesKey(entry.key);
    if (!parsed) {
      skipped++;
      continue;
    }
    channels.add(parsed.channel);
    if (!best || parsed.scanStartMs > bestParsed.scanStartMs) {
      best = entry;
      bestParsed = parsed;
    }
  }
  return { entry: best, parsed: bestParsed, skipped, channels: channels.size };
}

function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const satRaw = params.get('sat');
  let sat = null;
  if (satRaw != null) {
    sat = satRaw.trim().toUpperCase();
    if (!SAT_RE.test(sat))
      throw Object.assign(new Error(`goes_bad_sat: ${satRaw}`), {
        status: 400,
      });
  }
  return { sat, key: sat ?? '' };
}

async function fetchWithTimeout(
  fetchImpl,
  url,
  { method = 'GET', accept } = {},
) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method,
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). S3 virtual-hosted style
      // can 301 to a regional endpoint; STAR CDN 301s GOES16→GOES19.
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        ...(accept ? { Accept: accept } : {}),
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

function listUrl(bucket, prefix) {
  return `https://${bucket}.s3.amazonaws.com/?list-type=2&max-keys=${MAX_KEYS}&prefix=${encodeURIComponent(prefix)}`;
}

function imageryUrl(sat) {
  return `https://cdn.star.nesdis.noaa.gov/GOES${sat.slice(1)}/ABI/FD/GEOCOLOR/latest.jpg`;
}

/** One satellite: LIST current hour, fall back to previous hour, fail-soft imagery HEAD. */
async function fetchSatellite(fetchImpl, spec, nowMs) {
  const prefixes = [hourPrefix(nowMs), hourPrefix(nowMs - 3_600_000)];
  let entries = [];
  let truncated = false;
  let listOk = false;
  for (const prefix of prefixes) {
    let res;
    try {
      res = await fetchWithTimeout(fetchImpl, listUrl(spec.bucket, prefix), {
        accept: 'application/xml',
      });
    } catch {
      break; // network failure — keep whatever we have (likely nothing)
    }
    if (!res.ok) break;
    let text;
    try {
      text = await readResponseTextCapped(res, BODY_CAP_BYTES);
    } catch {
      break;
    }
    let parsed;
    try {
      parsed = parseListBucketXml(text);
    } catch {
      break;
    }
    listOk = true;
    if (parsed.entries.length > 0) {
      entries = parsed.entries;
      truncated = parsed.truncated;
      break;
    }
    // empty hour — try the previous hour (rollover edge), unless already there
  }

  const { entry, parsed, skipped, channels } = selectLatest(entries);
  const latestScan = parsed ? new Date(parsed.scanStartMs).toISOString() : null;
  const ageSec =
    parsed != null
      ? Math.max(0, Math.round((nowMs - parsed.scanStartMs) / 1000))
      : null;
  const dark = !listOk || entry == null || ageSec == null || ageSec > DARK_SEC;
  const fresh = !dark && ageSec != null && ageSec <= FRESH_SEC;

  // Fail-soft HEAD on the STAR CDN full-disk GeoColor JPEG (never 502s the route).
  let imageryOk = false;
  let imageryStatus = null;
  try {
    const head = await fetchWithTimeout(fetchImpl, imageryUrl(spec.sat), {
      method: 'HEAD',
    });
    imageryStatus = head.status;
    imageryOk = head.ok;
  } catch {
    imageryStatus = null;
  }

  return {
    sat: spec.sat,
    bucket: spec.bucket,
    role: spec.role,
    files: entries.length,
    truncated,
    skipped,
    channels,
    latestKey: entry?.key ?? null,
    latestChannel: parsed?.channel ?? null,
    latestScan,
    latestLastModified: entry?.lastModified ?? null,
    latestSizeBytes: entry?.sizeBytes ?? null,
    ageSec,
    fresh,
    dark,
    darkReason: dark
      ? !listOk
        ? 'list_unreachable'
        : entry == null
          ? 'no files in current+previous UTC hour'
          : 'latest scan older than 60 min'
      : null,
    imageryUrl: imageryUrl(spec.sat),
    imageryOk,
    imageryStatus,
    honesty:
      'CMIPF = Cloud and Moisture Imagery Product, Level-2, full disk — gridded ' +
      'radiances in NetCDF, not a rendered picture. latestScan = scan-start ' +
      'timestamp parsed from the S3 object key. Imagery URL = NESDIS STAR CDN ' +
      'full-disk GeoColor JPEG rendered by NOAA; never re-hosted or fabricated ' +
      'here; S3 NetCDF binaries (~3–5 MB) are never fetched at the edge.',
  };
}

async function fetchAll(fetchImpl, nowMs) {
  const rows = await Promise.all(
    SATELLITES.map((spec) => fetchSatellite(fetchImpl, spec, nowMs)),
  );
  // Total upstream outage (every LIST unreachable) is a provider-level
  // failure → honest 502, matching the d99a470 precedent. Partial
  // degradation stays a 200 with per-satellite dark rows.
  if (
    rows.length > 0 &&
    rows.every((r) => r.darkReason === 'list_unreachable')
  ) {
    throw Object.assign(
      new Error('goes_upstream_down: all S3 LISTs unreachable'),
      { status: 502 },
    );
  }
  return rows;
}

/** Build the publishable payload from per-satellite rows. Pure. */
export function buildGoesPayload(rows, { nowMs, query }) {
  let satellites = rows;
  let requestedNotFound = false;
  if (query.sat) {
    const match = rows.find((r) => r.sat === query.sat);
    satellites = match ? [match] : [];
    requestedNotFound = !match;
  }
  const fresh = rows.filter((r) => r.fresh).length;
  const dark = rows.filter((r) => r.dark).length;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale: false,
    count: satellites.length,
    requestedNotFound,
    summary: {
      total: rows.length,
      operational: rows.length - dark,
      fresh,
      dark,
    },
    satellites,
    attribution:
      'GOES Earth full-disk imagery availability: NOAA public S3 buckets ' +
      'noaa-goes16/17/18/19, ABI-L2-CMIPF ListObjectsV2 (keyless). ' +
      'latestScan = scan-start parsed from the object key (sYYYYDOYHHMMSS). ' +
      'Imagery URLs = NESDIS STAR CDN full-disk GeoColor JPEGs rendered by ' +
      'NOAA. fresh ≤20 min; dark = no files in the current+previous UTC hour ' +
      'or scan older than 60 min (GOES-16/17 on-orbit storage read dark — ' +
      'correctly, from live listings).',
  };
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

async function getDoc(fetchImpl, nowMs, signal) {
  if (docCache && nowMs - docCache.at < CACHE_TTL_MS) return docCache.rows;
  signal?.throwIfAborted?.();
  if (!docInflight) {
    // Retry gate fires only after a FAILED refresh — a success on one
    // query key must never block a different key (one refresh serves all).
    if (nowMs - docFailedAt < RETRY_COOLDOWN_MS)
      throw new Error('goes_retry_later');
    docInflight = fetchAll(fetchImpl, nowMs)
      .then((rows) => {
        docCache = { at: nowMs, rows };
        docFailedAt = -Infinity;
        return rows;
      })
      .catch((error) => {
        docFailedAt = nowMs;
        throw error;
      })
      .finally(() => {
        docInflight = null;
      });
  }
  const wait = docInflight;
  if (!signal) return wait;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const detach = () => signal.removeEventListener('abort', abort);
    wait.then(detach, detach);
  });
  return Promise.race([wait, cancelled]);
}

function rememberPayload(key, payload, nowMs) {
  payloadCache.set(key, { at: nowMs, payload });
  while (payloadCache.size > PAYLOAD_CACHE_MAX) {
    const oldest = payloadCache.keys().next().value;
    payloadCache.delete(oldest);
  }
}

async function getPayload(fetchImpl, query, nowMs, signal) {
  try {
    const rows = await getDoc(fetchImpl, nowMs, signal);
    const payload = buildGoesPayload(rows, { nowMs, query });
    rememberPayload(query.key, payload, nowMs);
    return payload;
  } catch (error) {
    // Stale fallback is key-scoped: only serve a payload captured for THIS query.
    const hit = payloadCache.get(query.key);
    if (hit && nowMs - hit.at <= STALE_MS)
      return {
        ...hit.payload,
        generatedAt: new Date(nowMs).toISOString(),
        stale: true,
      };
    throw error;
  }
}

export function goesProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      let query;
      try {
        query = parseQuery(req.url);
      } catch (error) {
        return sendJson(
          res,
          400,
          { error: 'goes_bad_request', detail: error.message },
          'no-store',
        );
      }
      try {
        const payload = await getPayload(
          fetchImpl,
          query,
          now(),
          controller.signal,
        );
        sendJson(res, 200, payload);
      } catch (error) {
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?|fetch failed/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: 'goes_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'goes',
    configureServer({ middlewares }) {
      middlewares.use('/api/goes', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/goes', handler);
    },
  };
}

export const _goesInternals = {
  SATELLITES,
  FRESH_SEC,
  DARK_SEC,
  numOrNull,
  hourPrefix,
  parseGoesKey,
  parseListBucketXml,
  selectLatest,
  buildGoesPayload,
  imageryUrl,
  clearCaches: () => {
    docCache = null;
    docInflight = null;
    docFailedAt = -Infinity;
    payloadCache.clear();
  },
};
