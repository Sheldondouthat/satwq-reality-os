/**
 * crt.sh certificate-transparency proxy (keyless) — cert-issuance ticker.
 *
 * Upstream: https://crt.sh/?q=<domain>&output=json (verified live 2026-09-27).
 * crt.sh responses can be enormous for popular domains, so the provider
 * reads are capped aggressively: a 4 MB body ceiling plus a hard row limit —
 * only the first MAX_CERTS rows are returned and `capped: true` is set when
 * the limit bites.
 *
 * Routes:
 *   GET /api/certs            → q=example.com
 *   GET /api/certs?q=some.io  → validated domain query
 *
 * Payload: {generatedAt, query, value, unit, certs:[...], capped, source,
 * attribution}.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'error' pinned host, no node: imports, no WASM).
 */

import { fetchJsonCapped, makeCache, sendJson, buildProxy } from './_lib.js';

const UPSTREAM_TIMEOUT_MS = 25_000; // crt.sh can be slow on first hit
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const MAX_CERTS = 50;
const MAX_Q_LENGTH = 253;
const CACHE_TTL_MS = 3600_000;
const DEFAULT_Q = 'example.com';
const SOURCE = 'crt.sh — Certificate Search (Sectigo)';
const ATTRIBUTION = 'crt.sh (free certificate transparency log search)';

/** Validate the q param: a sane domain-ish string, never blank. */
export function parseQueryParam(query = {}) {
  let q = typeof query.q === 'string' ? query.q.trim().toLowerCase() : '';
  if (!q) q = DEFAULT_Q;
  // Allow domain chars, leading wildcard, and % wildcards crt.sh accepts.
  if (!/^[%*a-z0-9]([a-z0-9\-.*%]{0,251})$/i.test(q) || q.length > MAX_Q_LENGTH) {
    throw Object.assign(new Error('certs_bad_query'), { status: 400 });
  }
  return q;
}

export function crtshUrl(q) {
  return `https://crt.sh/?q=${encodeURIComponent(q)}&output=json`;
}

/** Extract a short CA label from a long issuer DN ("C=GB, O=Sectigo Limited, CN=…"). */
export function issuerLabel(issuerName) {
  const dn = String(issuerName ?? '');
  const cn = /CN=([^,]+)/i.exec(dn)?.[1]?.trim();
  return cn || (dn ? dn.slice(0, 96) : '');
}

export function trimCert(row, now = Date.now()) {
  if (!row || typeof row !== 'object') return null;
  const names = String(row.name_value ?? '')
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean)
    .slice(0, 5);
  const notAfter = String(row.not_after ?? '');
  const expiresMs = Date.parse(notAfter);
  return {
    id: row.id ?? null,
    commonName: String(row.common_name ?? ''),
    names,
    issuer: issuerLabel(row.issuer_name),
    notBefore: String(row.not_before ?? ''),
    notAfter,
    expiresInDays: Number.isFinite(expiresMs)
      ? Math.round((expiresMs - now) / 86400_000)
      : null,
  };
}

export function trimCertsPayload(upstream, query) {
  if (!Array.isArray(upstream))
    throw Object.assign(new Error('certs_upstream_shape'), { status: 502 });
  const certs = [];
  for (const row of upstream) {
    const c = trimCert(row);
    if (c && c.commonName) certs.push(c);
    if (certs.length >= MAX_CERTS) break;
  }
  return {
    generatedAt: new Date().toISOString(),
    value: certs.length,
    unit: 'certificates',
    query,
    resultCount: certs.length,
    capped: upstream.length > certs.length,
    certs,
    source: SOURCE,
    attribution: ATTRIBUTION,
    honesty:
      'Certificate transparency log view only — crt.sh indexes publicly logged ' +
      `certs. Capped at ${MAX_CERTS} rows; issuance itself is reported by logs, not verified here.`,
  };
}

const buckets = new Map();
function cacheFor(q) {
  let entry = buckets.get(q);
  if (!entry) {
    entry = makeCache(
      async () =>
        trimCertsPayload(
          await fetchJsonCapped({
            url: crtshUrl(q),
            timeoutMs: UPSTREAM_TIMEOUT_MS,
            bodyCapBytes: BODY_CAP_BYTES,
            label: 'certs',
          }),
          q,
        ),
      CACHE_TTL_MS,
    );
    buckets.set(q, entry);
    if (buckets.size > MAX_CERTS) buckets.delete(buckets.keys().next().value);
  }
  return entry;
}

function parseQuery(req) {
  const full = String(req.originalUrl || req.url || '');
  const qIndex = full.indexOf('?');
  if (qIndex < 0) return {};
  const params = new URLSearchParams(full.slice(qIndex + 1));
  return { q: params.get('q') };
}

/** Mount the crt.sh proxy. Mirrors the vaac/nwsAlerts provider shape. */
export function certsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let q;
    try {
      q = parseQueryParam(parseQuery(req));
    } catch (error) {
      return sendJson(res, 400, { error: 'certs_bad_query', detail: 'invalid q parameter' }, 'no-store');
    }
    try {
      sendJson(res, 200, await cacheFor(q).get(), 'public, max-age=3600');
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        { error: 'certs_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }
  return buildProxy({ name: 'certs', route: '/api/certs', handler });
}

export const _certsInternals = {
  parseQueryParam,
  crtshUrl,
  issuerLabel,
  trimCert,
  trimCertsPayload,
  clearCaches: () => buckets.clear(),
};
