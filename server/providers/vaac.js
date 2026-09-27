/**
 * Tokyo VAAC advisory proxy (keyless).
 *
 * Tokyo VAAC serves no CORS headers, so browsers cannot fetch it directly.
 * This provider mirrors the VAAC list page and follows advisory links,
 * allow-listed to the VAAC data host and advisory-text paths only.
 *
 * Routes:
 *   GET /api/vaac            → Tokyo VAAC advisory list HTML
 *   GET /api/vaac?u=<url>    → one advisory's HTML (allow-listed host/path)
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, no node: imports, no WASM).
 */

const LIST_URL = 'https://ds.data.jma.go.jp/svd/vaac/data/vaac_list.html';
const ALLOWED_HOST = 'ds.data.jma.go.jp';
const ADVISORY_PATH_RE = /^\/svd\/vaac\/data\/TextData\//;
const UPSTREAM_TIMEOUT_MS = 15_000;
const BODY_CAP_BYTES = 256 * 1024;
const USER_AGENT = 'Gods Eye View (public VAAC context)';

async function fetchTextCapped(url, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT },
    });
    if (!response.ok) throw Object.assign(new Error(`vaac_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('vaac_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onAbort);
  }
}

function sendText(res, text) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  });
  res.end(text);
}

function sendError(res, status, code) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: code }));
}

/** Mount the VAAC proxy. Mirrors the hmsSmoke/cyclones provider shape. */
export function vaacProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed');
    const onClose = () => {};
    req.on?.('close', onClose);
    try {
      let target = LIST_URL;
      try {
        const parsed = new URL(req.url, 'http://localhost');
        const u = parsed.searchParams.get('u');
        if (u) {
          const advisory = new URL(u);
          if (advisory.hostname !== ALLOWED_HOST || !ADVISORY_PATH_RE.test(advisory.pathname))
            return sendError(res, 403, 'vaac_forbidden');
          target = advisory.toString();
        }
      } catch {
        return sendError(res, 400, 'vaac_bad_request');
      }
      try {
        sendText(res, await fetchTextCapped(target, null));
      } catch (error) {
        sendError(res, error.status === 502 ? 502 : 500, 'vaac_upstream_unavailable');
      }
    } finally {
      req.removeListener?.('close', onClose);
    }
  }

  return {
    name: 'vaac',
    configureServer({ middlewares }) {
      middlewares.use('/api/vaac', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/vaac', handler);
    },
  };
}
