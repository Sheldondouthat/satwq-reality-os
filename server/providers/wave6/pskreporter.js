/**
 * Wave 6 — PSKReporter reception-report proxy (keyless, amateur use).
 *
 * PSKReporter's query API serves live global "who's hearing whom" HF
 * reception reports as XML. This provider parses the XML with regexes
 * (no DOMParser at the edge), converts Maidenhead grid squares to
 * lat/lon, trims each report to globe-sized fields, and caches.
 *
 * Routes:
 *   GET /api/pskreporter → {generatedAt, windowSec, count, reports:[...]}
 *
 * Report shape: {sender, receiver, freqMHz, mode, snrDb, time,
 *   txLat, txLon, rxLat, rxLon}
 *
 * PSKReporter asks amateur users not to hammer the query API: 5-minute
 * cache. The example sender K1JT (Joe Taylor, WSJT-X author) is used as
 * the query anchor; reception reports describe who heard his signal.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error' throws at the edge (main 2ec4053)
 * per the 2026-09-27 edge incident — no node: imports, no WASM).
 */

const UPSTREAM_URL =
  'https://retrieve.pskreporter.info/query?senderCallsign=K1JT&flowStartSeconds=-3600&rronly=1';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_REPORTS = 1500;
const WINDOW_SEC = 3600;
const USER_AGENT = 'Gods Eye View (amateur reception-report context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchTextCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml, text/xml' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`pskreporter_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('pskreporter_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Maidenhead grid square → {lat, lon} at the center of the finest square.
 * Accepts 4- or 6-character locators (case-insensitive). Returns null for
 * anything that is not a plausible locator.
 */
export function gridToLatLon(grid) {
  if (typeof grid !== 'string') return null;
  const g = grid.trim().toUpperCase();
  if (!/^[A-R]{2}[0-9]{2}([A-X]{2})?$/.test(g)) return null;
  let lon = (g.charCodeAt(0) - 65) * 20 - 180 + (g.charCodeAt(2) - 48) * 2;
  let lat = (g.charCodeAt(1) - 65) * 10 - 90 + (g.charCodeAt(3) - 48) * 1;
  if (g.length === 6) {
    // Subsquare center measured from the square's SW corner.
    lon += (g.charCodeAt(4) - 65) * (5 / 60) + 5 / 120;
    lat += (g.charCodeAt(5) - 65) * (2.5 / 60) + 2.5 / 120;
  } else {
    // 4-char grid: center of the whole square.
    lon += 1;
    lat += 0.5;
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

function parseReportTag(tag) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)="([^"]*)"/g;
  let m;
  while ((m = re.exec(tag)) !== null) attrs[m[1]] = m[2];
  return attrs;
}

function roundNum(value, decimals = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Parse the PSKReporter `<receptionReport>` stream. A report is kept when
 * the receiver side resolves to a position (the hearing station); the
 * sender side may legitimately lack a locator and then carries nulls.
 */
export function parseReceptionReports(xml) {
  if (typeof xml !== 'string' || !xml) return [];
  const reports = [];
  const tagRe = /<receptionReport\b[^>]*\/?>/gi;
  let tag;
  while ((tag = tagRe.exec(xml)) !== null) {
    const a = parseReportTag(tag[0]);
    const rx = gridToLatLon(a.receiverLocator);
    if (!rx) continue;
    const tx = gridToLatLon(a.senderLocator);
    const timeMs = Number(a.flowStartSeconds) * 1000;
    const freqHz = Number(a.frequencyHz);
    reports.push({
      sender: String(a.senderCallsign ?? '').slice(0, 16),
      receiver: String(a.receiverCallsign ?? '').slice(0, 16),
      freqMHz: Number.isFinite(freqHz) && freqHz > 0 ? roundNum(freqHz / 1e6, 4) : null,
      mode: String(a.mode ?? '').slice(0, 16),
      snrDb: a.sNR != null && a.sNR !== '' ? roundNum(Number(a.sNR), 1) : null,
      time: Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : null,
      txLat: tx ? roundNum(tx.lat) : null,
      txLon: tx ? roundNum(tx.lon) : null,
      rxLat: roundNum(rx.lat),
      rxLon: roundNum(rx.lon),
    });
    if (reports.length >= MAX_REPORTS) break;
  }
  reports.sort((a, b) => String(b.time ?? '').localeCompare(String(a.time ?? '')));
  return reports;
}

export function trimPskPayload(xml) {
  const reports = parseReceptionReports(xml);
  return {
    generatedAt: new Date().toISOString(),
    windowSec: WINDOW_SEC,
    count: reports.length,
    reports,
    note: 'PSKReporter reception reports for sender K1JT, trailing 1h (rronly). Grid locators converted to lat/lon centers.',
    source: 'PSKReporter (free amateur use; please do not hammer)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchTextCapped(UPSTREAM_URL)
      .then((xml) => {
        const payload = trimPskPayload(xml);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=300') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the PSKReporter reception-report proxy. Mirrors the felt provider shape. */
export function pskreporterProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'pskreporter_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'pskreporter',
    configureServer({ middlewares }) {
      middlewares.use('/api/pskreporter', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/pskreporter', handler);
    },
  };
}

export const _pskreporterInternals = {
  gridToLatLon,
  parseReceptionReports,
  trimPskPayload,
  clearCaches: () => { cache = null; inflight = null; },
};
