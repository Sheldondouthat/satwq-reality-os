/**
 * Wave 3 / Track 3b — NOAA AOML Sargassum Watch provider (keyless).
 *
 * Upstream: https://cwcgom.aoml.noaa.gov/SIR/ (official Sargassum Inundation
 * Report page). The current analysis date is read from the page's selected
 * <option value="SIR_YYYYMMDD">; each analysis publishes five regional risk
 * PNGs plus a KMZ of risk polygons and a PDF report.
 *
 * There is no public vector API (no WMS/GeoJSON/KML — probed 2026-09-27,
 * all 404) and the KMZ is a ZIP which this runtime will not inflate, so the
 * provider is an honest image-overlay scraper: it returns the official
 * regional PNG URLs and proxies them same-origin for the frontend.
 * The risk colors come from NOAA's own rendering — the provider performs no
 * image analysis and makes no numerical claims about the PNG contents.
 */

export const SARGASSUM_ROUTE = '/api/sargassum';
export const SARGASSUM_IMAGE_ROUTE = '/api/sargassum/image';

const SIR_BASE = 'https://cwcgom.aoml.noaa.gov/SIR/';
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024;
const CACHE_TTL_MS = 6 * 3600_000; // analyses are weekly
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless NOAA AOML Sargassum Watch context; contact: public repo)';

/** Official regions, in page order. Names are the page's alt text (OBSERVED). */
export const SARGASSUM_REGIONS = [
  { code: 'GOMF', name: 'Gulf of America' },
  { code: 'CA', name: 'Central America' },
  { code: 'GREATER', name: 'Greater Caribbean' },
  { code: 'LESSER', name: 'Lesser Antilles' },
  { code: 'SA', name: 'South America' },
];

const REGION_CODES = new Set(SARGASSUM_REGIONS.map((r) => r.code));

const HONESTY =
  'Regional risk maps are NOAA AOML official PNG renderings (Sargassum ' +
  'Inundation Report). They are images, not data — this provider performs ' +
  'no pixel analysis and reports no numerical risk values. For polygons, ' +
  'download the linked KMZ.';

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Extract the current analysis date (YYYYMMDD) from the page HTML. */
export function parseAnalysisDate(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<option[^>]*value="SIR_(\d{8})"[^>]*selected[^>]*>/i);
  if (m) return m[1];
  // fallback: newest date directory referenced by regional images
  const dirs = [...html.matchAll(/\.\/images\/(\d{8})\/[A-Z]+\.png/g)].map(
    (x) => x[1],
  );
  if (!dirs.length) return null;
  return dirs.sort().pop();
}

/** True when the date directory has all five regional PNGs on the page. */
export function regionsPresent(html, dateStr) {
  if (typeof html !== 'string' || !/^\d{8}$/.test(dateStr || '')) return [];
  return SARGASSUM_REGIONS.filter((r) =>
    html.includes(`./images/${dateStr}/${r.code}.png`),
  ).map((r) => r.code);
}

/** Build the describe document for an analysis date. Pure. */
export function describeSargassum({ dateStr, regions, fetchedAt, origin }) {
  const proxied = (code) =>
    `${origin}${SARGASSUM_IMAGE_ROUTE}?date=${dateStr}&region=${code}`;
  return {
    schemaVersion: 1,
    source: 'NOAA AOML Sargassum Inundation Report',
    attribution:
      'Imagery: NOAA Atlantic Oceanographic and Meteorological Laboratory (AOML)',
    analysisDate: dateStr,
    fetchedAt,
    stale: false,
    unavailable: false,
    reason: null,
    honesty: HONESTY,
    regions: regions.map((r) => ({
      code: r.code,
      name: r.name,
      imageUrl: `${SIR_BASE}images/${dateStr}/${r.code}.png`,
      barUrl: `${SIR_BASE}images/${dateStr}/${r.code}_bar.png`,
      proxiedImageUrl: proxied(r.code),
      proxiedBarUrl: `${origin}${SARGASSUM_IMAGE_ROUTE}?date=${dateStr}&region=${r.code}&kind=bar`,
    })),
    kmzUrl: `${SIR_BASE}KMZ/sargassum_risk_${dateStr}.kmz`,
    pdfUrl: `${SIR_BASE}PDF/SIR_${dateStr}.pdf`,
  };
}

async function fetchTextCapped(url, fetchImpl, signal) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal,
  });
  if (!res.ok) throw new Error(`SIR HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > BODY_CAP_BYTES) throw new Error('SIR page exceeds cap');
  return text;
}

export function sargassumProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ttlMs = CACHE_TTL_MS,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let mem = null;
  let inflight = null;

  async function refreshUpstream(origin) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const html = await fetchTextCapped(
        SIR_BASE,
        fetchImpl,
        controller.signal,
      );
      const dateStr = parseAnalysisDate(html);
      if (!dateStr) throw new Error('no analysis date found on SIR page');
      const present = regionsPresent(html, dateStr);
      if (!present.length)
        throw new Error('no regional images found for ' + dateStr);
      const regions = SARGASSUM_REGIONS.filter((r) => present.includes(r.code));
      return { at: Date.now(), dateStr, regions, origin };
    } finally {
      clearTimeout(timer);
    }
  }

  function refreshSingleFlight(origin) {
    if (!inflight) {
      inflight = refreshUpstream(origin).finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  function originFromReq(req) {
    const host = req?.headers?.host || '';
    const proto = /^localhost(:|$)/.test(host) ? 'http' : 'https';
    return `${proto}://${host}`;
  }

  const installMiddleware = (server) => {
    // — main document —
    server.middlewares.use(SARGASSUM_ROUTE, async (req, res) => {
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
        const origin = originFromReq(req);
        const now = Date.now();
        if (!mem || now - mem.at > ttlMs) {
          try {
            mem = await refreshSingleFlight(origin);
          } catch (err) {
            console.warn(
              '[sargassum-proxy] upstream failed:',
              err?.message || err,
            );
            if (!mem) {
              sendJson(503, {
                error: 'sargassum_unavailable',
                honesty: HONESTY,
              });
              return;
            }
            mem = { ...mem, stale: true };
          }
        }
        const doc = describeSargassum({
          dateStr: mem.dateStr,
          regions: mem.regions,
          fetchedAt: new Date(mem.at).toISOString(),
          origin,
        });
        if (mem.stale) {
          doc.stale = true;
          doc.reason = 'Upstream unreachable; showing last good analysis.';
        }
        sendJson(200, doc);
      } catch {
        sendJson(500, { error: 'sargassum proxy error' });
      }
    });

    // — same-origin image proxy (no hotlink dependence, no mixed content) —
    server.middlewares.use(SARGASSUM_IMAGE_ROUTE, async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'method_not_allowed' }));
          return;
        }
        const url = new URL(req.url || '/', 'http://localhost');
        const date = url.searchParams.get('date') || '';
        const region = url.searchParams.get('region') || '';
        const kind = url.searchParams.get('kind') || '';
        // SSRF guard: strict allowlist — only the official SIR image paths.
        if (
          !/^\d{8}$/.test(date) ||
          !REGION_CODES.has(region) ||
          (kind !== '' && kind !== 'bar')
        ) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_sargassum_image_request' }));
          return;
        }
        const upstreamUrl = `${SIR_BASE}images/${date}/${region}${kind === 'bar' ? '_bar' : ''}.png`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const upstream = await fetchImpl(upstreamUrl, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'image/png' },
            signal: controller.signal,
          });
          if (!upstream.ok) throw new Error(`image HTTP ${upstream.status}`);
          const buf = Buffer.from(await upstream.arrayBuffer());
          if (!buf.length || buf.length > 8 * 1024 * 1024) {
            throw new Error('image size out of bounds');
          }
          res.writeHead(200, {
            'Content-Type': 'image/png',
            'Cache-Control': 'public, max-age=21600',
            'Content-Length': buf.length,
          });
          res.end(buf);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'sargassum_image_unavailable' }));
        }
      }
    });
  };

  return {
    name: 'sargassum-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
