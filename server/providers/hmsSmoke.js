/**
 * NOAA HMS (Hazard Mapping System) daily smoke-polygon KML proxy, keyless.
 *
 * Upstream: https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML/{YYYY}/{MM}/hms_smoke{YYYYMMDD}.kml
 * (daily file for the prior day, refreshed ~00:13 UTC).
 *
 * The upstream server sends NO Access-Control-Allow-Origin header, so the
 * browser cannot fetch it directly — this plugin mounts GET /api/hms-smoke
 * and relays the KML through the dev server. Shape mirrors firmsProxy:
 * 1 h memory cache, single-flight refresh, serve-stale-on-failure.
 *
 * Route: GET /api/hms-smoke → KML (application/vnd.google-earth.kml+xml)
 *   on total failure → 503 {"error":"hms_unavailable"}
 *
 * No API key. Upstream fetches are capped at ~5 MB with a 15 s timeout.
 *
 * @returns {import('vite').Plugin}
 */
const HMS_KML_ROOT =
  'https://satepsanone.nesdis.noaa.gov/pub/FIRE/web/HMS/Smoke_Polygons/KML';

export const HMS_SMOKE_ROUTE = '/api/hms-smoke';

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * UTC calendar parts for a Date, plus the compact YYYYMMDD tag HMS uses in
 * file names. Pure — dates are always computed in UTC because the HMS daily
 * file rolls over at ~00:13 UTC.
 */
export function hmsSmokeUtcDateParts(date) {
  const y = String(date.getUTCFullYear());
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  return { y, m, ymd: `${y}${m}${d}` };
}

/** KML URL for one UTC calendar day. */
export function hmsSmokeDayUrl({ y, m, ymd }) {
  return `${HMS_KML_ROOT}/${y}/${m}/hms_smoke${ymd}.kml`;
}

/**
 * Candidate upstream URLs, today first then yesterday (both in UTC).
 * Yesterday is the fallback because today's file only appears after the
 * ~00:13 UTC analysis completes; before that today's URL 404s.
 */
export function hmsSmokeCandidateUrls(now = new Date()) {
  const today = hmsSmokeUtcDateParts(now);
  const yesterday = hmsSmokeUtcDateParts(new Date(now.getTime() - 86_400_000));
  return [
    { date: today.ymd, url: hmsSmokeDayUrl(today) },
    { date: yesterday.ymd, url: hmsSmokeDayUrl(yesterday) },
  ];
}

const KML_OPEN_RE = /<kml[\s>]/i;

/**
 * Pure fallback selection: given the probe results for each candidate URL
 * (in candidate order), return the first attempt that was both HTTP-ok and
 * looks like a KML document, or null when every candidate failed.
 * Each attempt: {date, url, ok, looksLikeKml}.
 */
export function pickHmsSmokeCandidate(attempts) {
  for (const attempt of attempts) {
    if (attempt && attempt.ok && attempt.looksLikeKml) return attempt;
  }
  return null;
}

function looksLikeKml(text) {
  return (
    typeof text === 'string' &&
    text.length > 0 &&
    /^\s*</.test(text) &&
    KML_OPEN_RE.test(text)
  );
}

export function hmsSmokeProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ttlMs = 3600_000,
  maxBytes = 5 * 1024 * 1024,
  timeoutMs = 15_000,
} = {}) {
  /** @type {?{at:number, date:string, body:string}} */
  let mem = null;
  /** @type {?Promise<?{at:number, date:string, body:string}>} single-flight refresh */
  let inflight = null;

  async function fetchCandidate(candidate) {
    const res = await fetchImpl(candidate.url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const text = await res.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`HMS KML exceeds ${maxBytes} byte cap`);
    }
    if (!looksLikeKml(text)) return null;
    return { at: Date.now(), date: candidate.date, body: text };
  }

  async function refreshUpstream() {
    let lastError = null;
    for (const candidate of hmsSmokeCandidateUrls(new Date())) {
      try {
        const entry = await fetchCandidate(candidate);
        if (entry) return entry;
      } catch (err) {
        lastError = err;
        console.warn(
          `[hms-smoke-proxy] ${candidate.date} fetch failed:`,
          err?.message || err,
        );
      }
    }
    throw lastError || new Error('all HMS KML candidates failed');
  }

  function refreshSingleFlight() {
    if (!inflight) {
      inflight = refreshUpstream().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use(HMS_SMOKE_ROUTE, async (req, res) => {
      const sendJson = (status, bodyObj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bodyObj));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        const now = Date.now();
        if (mem && now - mem.at < ttlMs) {
          res.writeHead(200, {
            'Content-Type': 'application/vnd.google-earth.kml+xml',
            'X-Cache': 'hit',
            'X-HMS-Date': mem.date,
          });
          res.end(mem.body);
          return;
        }
        try {
          mem = await refreshSingleFlight();
          res.writeHead(200, {
            'Content-Type': 'application/vnd.google-earth.kml+xml',
            'X-Cache': 'miss',
            'X-HMS-Date': mem.date,
          });
          res.end(mem.body);
        } catch (err) {
          // Serve stale on failure so the globe keeps showing yesterday's
          // smoke instead of dropping the layer on a transient outage.
          if (mem) {
            console.warn(
              '[hms-smoke-proxy] upstream failed — serving stale KML',
            );
            res.writeHead(200, {
              'Content-Type': 'application/vnd.google-earth.kml+xml',
              'X-Cache': 'stale',
              'X-HMS-Date': mem.date,
            });
            res.end(mem.body);
            return;
          }
          sendJson(503, { error: 'hms_unavailable' });
        }
      } catch (err) {
        console.error('[hms-smoke-proxy] request failed');
        sendJson(500, { error: 'hms smoke proxy error' });
      }
    });
  };
  return {
    name: 'hms-smoke-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
