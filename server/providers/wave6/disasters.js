/**
 * Wave 6 — FEMA disaster-declaration proxy (keyless).
 *
 *   #132 FEMA https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries
 *        JSON OData, no key. Newest declarations first via $orderby.
 *
 * Routes:
 *   GET /api/disasters → {generatedAt, count, declarations:[...]}
 *
 * Declarations carry no coordinates in this endpoint — state + designated
 * area only, labeled honestly. Long cache: declarations are not minute-fresh.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 */

const UPSTREAM_URL =
  'https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries?$orderby=declarationDate%20desc&$top=25';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60_000;
const MAX_DECLARATIONS = 50;
const USER_AGENT = 'Gods Eye View (public disaster-declaration context)';

let cache = null; // {at, payload}
let inflight = null;

async function fetchJsonCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`fema_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('fema_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(new TextDecoder().decode(buffer));
  } finally {
    clearTimeout(timeout);
  }
}

function trimDeclaration(d) {
  if (!d || typeof d !== 'object') return null;
  const id = String(d.femaDeclarationString ?? d.id ?? '');
  if (!id) return null;
  const programs = {
    individualHouseholds: Boolean(d.ihProgramDeclared),
    individualAssistance: Boolean(d.iaProgramDeclared),
    publicAssistance: Boolean(d.paProgramDeclared),
    hazardMitigation: Boolean(d.hmProgramDeclared),
  };
  return {
    id,
    declarationNumber: Number.isFinite(Number(d.disasterNumber))
      ? Number(d.disasterNumber)
      : null,
    state: String(d.state ?? ''),
    declarationType: String(d.declarationType ?? ''),
    declarationDate: d.declarationDate ?? null,
    incidentType: String(d.incidentType ?? ''),
    title: String(d.declarationTitle ?? '').slice(0, 240),
    designatedArea: String(d.designatedArea ?? '').slice(0, 240),
    incidentBegin: d.incidentBeginDate ?? null,
    incidentEnd: d.incidentEndDate ?? null,
    region: Number.isFinite(Number(d.region)) ? Number(d.region) : null,
    tribalRequest: Boolean(d.tribalRequest),
    programs,
    lastRefresh: d.lastRefresh ?? null,
  };
}

export function trimDisastersPayload(upstream) {
  const rows = Array.isArray(upstream?.DisasterDeclarationsSummaries)
    ? upstream.DisasterDeclarationsSummaries
    : [];
  const declarations = rows
    .map(trimDeclaration)
    .filter(Boolean)
    .slice(0, MAX_DECLARATIONS);
  return {
    generatedAt: new Date().toISOString(),
    count: declarations.length,
    // The summaries endpoint carries no coordinates — state/area only.
    geoCoverage:
      'state + designated area (no coordinates in FEMA summaries endpoint)',
    declarations,
    source:
      'FEMA OpenFEMA API — Disaster Declarations Summaries (public domain)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchJsonCapped(UPSTREAM_URL)
      .then((upstream) => {
        const payload = trimDisastersPayload(upstream);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=3600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the FEMA disaster-declarations proxy. Mirrors the wave5 felt provider shape. */
export function disastersProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'disasters_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'disasters',
    configureServer({ middlewares }) {
      middlewares.use('/api/disasters', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/disasters', handler);
    },
  };
}

export const _disastersInternals = {
  trimDeclaration,
  trimDisastersPayload,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
