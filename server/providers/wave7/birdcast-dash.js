/**
 * Wave 7 — BirdCast live migration dashboard embed metadata (no HTML proxied).
 *
 * The BirdCast dashboard (#148, https://dashboard.birdcast.org/live-maps?embed=true)
 * is a ~1 MB Nuxt JS app — there is no machine-readable JSON behind it, and
 * proxying its HTML through the edge would be wasteful and fragile. Per the
 * Wave C brief this provider returns the embed target plus metadata; the
 * client renders it in an <iframe>. The machine-readable migration path is
 * the sibling /api/birdcast provider (S3 mosaic manifest, wave6 #145).
 *
 * Routes:
 *   GET /api/birdcast-dash → {generatedAt, embedUrl, embedType, title,
 *     description, embedHtml, mosaicApi, attribution, probe, note}
 *
 * The payload is static catalog metadata, so the liveness probe is advisory:
 * a capped (64 KB) GET checks the dashboard still serves 200 + HTML and the
 * result is recorded honestly in `probe`. A failed probe degrades to
 * probe.ok:false — it never 502s the endpoint, because the embed metadata
 * itself remains valid (catalog-verified 2026-09-27). Only a genuine internal
 * bug yields 500; the standard upstreamFail classifier is kept for that path.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 *
 * Probe notes (2026-09-27, build VM): GET live-maps?embed=true → 200,
 * text/html; charset=utf-8, ~1,000,798 bytes in 1.7s; <title>Live Migration
 * Maps - BirdCast</title> (Nuxt SSR shell). Range requests are ignored by the
 * origin, so the edge caps the read instead of relying on them.
 */

const EMBED_URL = 'https://dashboard.birdcast.org/live-maps?embed=true';
const DASHBOARD_TITLE = 'Live Migration Maps - BirdCast';
const UPSTREAM_TIMEOUT_MS = 20_000;
const PROBE_CAP_BYTES = 64 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const USER_AGENT = 'Gods Eye View (BirdCast dashboard liveness probe)';

let cache = null; // {at, payload}
let inflight = null;

function pageTitleFromHead(html) {
  const m = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(String(html ?? ''));
  return m ? m[1].trim() : null;
}

export function buildEmbedHtml(url = EMBED_URL, title = DASHBOARD_TITLE) {
  const safeUrl = String(url).replace(/"/g, '%22');
  const safeTitle = String(title).replace(/"/g, '');
  return (
    `<iframe src="${safeUrl}" title="${safeTitle}" loading="lazy" ` +
    `referrerpolicy="no-referrer" allow="fullscreen" ` +
    `style="border:0;width:100%;height:640px;min-height:60vh"></iframe>`
  );
}

/**
 * Advisory liveness probe: capped GET of the dashboard shell. Never throws —
 * failures are returned as {ok:false, error} so the static metadata payload
 * still serves.
 */
export async function probeDashboard(fetchImpl, url = EMBED_URL) {
  const checkedAt = new Date().toISOString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml' },
    });
    const contentType = response.headers?.get?.('content-type') ?? null;
    if (!response.ok) {
      return { ok: false, status: response.status, contentType, pageTitle: null, checkedAt, error: `dashboard_http_${response.status}` };
    }
    const buffer = await response.arrayBuffer();
    const html = new TextDecoder().decode(buffer.slice(0, Math.min(buffer.byteLength, PROBE_CAP_BYTES)));
    return {
      ok: true,
      status: response.status,
      contentType,
      pageTitle: pageTitleFromHead(html),
      checkedAt,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      status: null,
      contentType: null,
      pageTitle: null,
      checkedAt,
      error: error?.message ?? 'unknown',
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildPayload(probe) {
  return {
    generatedAt: new Date().toISOString(),
    embedUrl: EMBED_URL,
    embedType: 'iframe',
    title: DASHBOARD_TITLE,
    description:
      'BirdCast live migration maps and forecasts (Cornell Lab of Ornithology). ' +
      'Embed the URL in an <iframe>; the dashboard is a JS app with no machine-readable JSON — do not proxy its HTML.',
    embedHtml: buildEmbedHtml(),
    mosaicApi: '/api/birdcast',
    attribution:
      'Dashboard: BirdCast, Cornell Lab of Ornithology. ' +
      'For the machine-readable migration mosaic manifest see /api/birdcast (S3 mosaic index, wave6 #145).',
    probe,
    note:
      'The probe is advisory: probe.ok:false means the dashboard did not answer ' +
      'this check, not that the embed URL is wrong (catalog-verified 2026-09-27).',
  };
}

async function getSnapshot(fetchImpl) {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = (async () => {
      const probe = await probeDashboard(fetchImpl);
      const payload = buildPayload(probe);
      cache = { at: Date.now(), payload };
      return payload;
    })().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the BirdCast dashboard embed-metadata endpoint. */
export function birdcastDashProxy({ fetchImpl = fetch } = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot(fetchImpl));
    } catch (error) {
      // Unreachable in practice (probeDashboard never throws); kept for the
      // honest-failure contract: real upstream-shaped failures → 502.
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        { error: 'birdcast_dash_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }

  return {
    name: 'birdcast-dash',
    configureServer({ middlewares }) {
      middlewares.use('/api/birdcast-dash', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/birdcast-dash', handler);
    },
  };
}

export const _birdcastDashInternals = {
  buildEmbedHtml,
  probeDashboard,
  pageTitleFromHead,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
