/**
 * Wave 3 / Track 3b — Cumiana Schumann-resonance panel provider (keyless).
 *
 * Upstream: http://www.vlf.it/cumiana/livedata.html (Renato Romero's VLF
 * observatory, Cumiana, Italy). Two live charts:
 *   - last_E-VLF.jpg : electric-field VLF spectrogram (page: updated 30 min)
 *   - last-plotted.jpg : detected values plotted every 150 s (page: updated 30 min)
 *
 * The station is HTTP-only (HTTPS probed 2026-09-27: fails), so an HTTPS app
 * cannot embed the charts directly — this provider proxies them same-origin.
 * The charts are IMAGES, not telemetry: there is no numerical 7.83 Hz feed
 * here. The honesty note says so; the frontend must label the signal
 * image-derived.
 */

export const SCHUMANN_ROUTE = '/api/schumann';
export const SCHUMANN_IMAGE_ROUTE = '/api/schumann/image';

const CUMIANA_BASE = 'http://www.vlf.it/cumiana/';
const PAGE_URL = `${CUMIANA_BASE}livedata.html`;
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 256 * 1024;
const IMAGE_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 20 * 60_000; // charts update every ~30 min
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless Cumiana VLF chart context; contact: public repo)';

export const SCHUMANN_CHARTS = [
  {
    kind: 'evlf',
    file: 'last_E-VLF.jpg',
    title: 'E-field VLF spectrogram',
    cadenceNote: 'page states updated every 30 minutes',
  },
  {
    kind: 'plotted',
    file: 'last-plotted.jpg',
    title: 'Detected values (150 s sampling)',
    cadenceNote:
      'page states values detected every 150 s, picture every 30 min',
  },
];

const KIND_FILES = new Map(SCHUMANN_CHARTS.map((c) => [c.kind, c.file]));

const HONESTY =
  'These are live CHART IMAGES from the Cumiana VLF observatory, not ' +
  'numerical telemetry. No 7.83 Hz amplitude/frequency values are measured ' +
  'or derived here — any "signal strength" reading would be pixel ' +
  'interpretation, which this provider does not perform.';

async function fetchTextCapped(url, fetchImpl, signal) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal,
  });
  if (!res.ok) throw new Error(`Cumiana HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > BODY_CAP_BYTES) throw new Error('Cumiana page exceeds cap');
  return text;
}

/** Verify the expected chart files are referenced on the page. Pure. */
export function chartsReferenced(html) {
  if (typeof html !== 'string') return [];
  return SCHUMANN_CHARTS.filter((c) => html.includes(c.file)).map(
    (c) => c.kind,
  );
}

export function describeSchumann({ kinds, fetchedAt, origin }) {
  return {
    schemaVersion: 1,
    source: 'VLF observatory, Cumiana, Italy (vlf.it)',
    attribution: 'Charts: Renato Romero / vlf.it — proxied live, unmodified',
    fetchedAt,
    stale: false,
    unavailable: false,
    reason: null,
    honesty: HONESTY,
    charts: SCHUMANN_CHARTS.filter((c) => kinds.includes(c.kind)).map((c) => ({
      kind: c.kind,
      title: c.title,
      cadenceNote: c.cadenceNote,
      directUrl: `${CUMIANA_BASE}${c.file}`,
      proxiedUrl: `${origin}${SCHUMANN_IMAGE_ROUTE}?kind=${c.kind}`,
    })),
  };
}

export function schumannProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ttlMs = CACHE_TTL_MS,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let mem = null;
  let inflight = null;

  async function refreshUpstream() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const html = await fetchTextCapped(
        PAGE_URL,
        fetchImpl,
        controller.signal,
      );
      const kinds = chartsReferenced(html);
      if (!kinds.length)
        throw new Error('no known charts referenced on Cumiana page');
      return { at: Date.now(), kinds };
    } finally {
      clearTimeout(timer);
    }
  }

  function refreshSingleFlight() {
    if (!inflight) {
      inflight = refreshUpstream().finally(() => {
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
    server.middlewares.use(SCHUMANN_ROUTE, async (req, res) => {
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
            mem = await refreshSingleFlight();
          } catch (err) {
            console.warn(
              '[schumann-proxy] upstream failed:',
              err?.message || err,
            );
            if (!mem) {
              sendJson(503, {
                error: 'schumann_unavailable',
                honesty: HONESTY,
              });
              return;
            }
            mem = { ...mem, stale: true };
          }
        }
        const doc = describeSchumann({
          kinds: mem.kinds,
          fetchedAt: new Date(mem.at).toISOString(),
          origin,
        });
        if (mem.stale) {
          doc.stale = true;
          doc.reason =
            'Upstream unreachable; showing last good chart references.';
        }
        sendJson(200, doc);
      } catch {
        sendJson(500, { error: 'schumann proxy error' });
      }
    });

    server.middlewares.use(SCHUMANN_IMAGE_ROUTE, async (req, res) => {
      try {
        if (req.method !== 'GET') {
          res.writeHead(405, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'method_not_allowed' }));
          return;
        }
        const url = new URL(req.url || '/', 'http://localhost');
        const kind = url.searchParams.get('kind') || '';
        const file = KIND_FILES.get(kind); // strict allowlist — no SSRF
        if (!file) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid_schumann_image_request' }));
          return;
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const upstream = await fetchImpl(`${CUMIANA_BASE}${file}`, {
            headers: { 'User-Agent': USER_AGENT, Accept: 'image/jpeg' },
            signal: controller.signal,
          });
          if (!upstream.ok) throw new Error(`image HTTP ${upstream.status}`);
          const buf = Buffer.from(await upstream.arrayBuffer());
          if (!buf.length || buf.length > IMAGE_CAP_BYTES) {
            throw new Error('image size out of bounds');
          }
          res.writeHead(200, {
            'Content-Type': 'image/jpeg',
            'Cache-Control': 'public, max-age=1200',
            'Content-Length': buf.length,
          });
          res.end(buf);
        } finally {
          clearTimeout(timer);
        }
      } catch {
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'schumann_image_unavailable' }));
        }
      }
    });
  };

  return {
    name: 'schumann-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
