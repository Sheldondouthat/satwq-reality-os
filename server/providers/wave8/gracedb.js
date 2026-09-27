/**
 * Wave 8 — GraceDB gravitational-wave superevents (catalog Wave D item 72, #71).
 *
 * MANDATORY HONEST LABELING: between LVK science runs, GraceDB's recent
 * superevents are dominated by MDC (Mock Data Challenge) injections —
 * simulated signals used to exercise the pipelines, NOT astrophysical
 * detections. Presenting them as real events would be a fabrication, so every
 * event carries an explicit `mock` boolean and `mockReason`, and the payload
 * carries aggregate mock/real counts plus a plain-language disclaimer.
 *
 * Mock detection (all server-side, deterministic):
 *   - category === "MDC" (the API's own classification), OR
 *   - superevent_id matches the MDC naming pattern (MS…, e.g. "MS260927v";
 *     real superevents are named S… e.g. "S250626bn").
 *
 * t_0 is reported in GPS seconds — converted here to an ISO-8601 UTC
 * instant with an explicit "gps" note so nobody mistakes the epoch.
 *
 * Probe notes (2026-09-27, build VM): /api/superevents/?N=3 → 200,
 * numRows 6030, all three recent events category "MDC" with MS-prefixed ids,
 * created "2026-09-27 21:28:50 UTC", far ~5e-16, labels include SIGNIF_LOCKED
 * (labels on mock injections do not make them real).
 *
 * Routes:
 *   GET /api/gracedb[?n=1..50] → { generatedAt, total, returned, mockCount,
 *     realCount, allRecentAreMock, disclaimer, events:[{id, mock, mockReason,
 *     category, tGps, tIso, created, far, labels, preferredPipeline,
 *     instruments}], attribution }
 *
 * Keyless, LIGO open data, Pages-safe (global fetch only, capped reads,
 * redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

import { readResponseTextCapped } from '../common/http.js';

const SUPEREVENTS_URL = (n) =>
  `https://gracedb.ligo.org/api/superevents/?N=${n}`;
const DEFAULT_N = 20;
const MAX_N = 50;
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024; // 20-event payloads are ~100 KB; 2 MB is headroom
const CACHE_TTL_MS = 10 * 60_000;
const STALE_MS = 6 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const USER_AGENT = 'Gods Eye View (GraceDB superevents layer)';

const DISCLAIMER =
  'Events labeled mock:true are MDC (Mock Data Challenge) injections — ' +
  'simulated gravitational-wave signals used to test the LVK pipelines. ' +
  'They are NOT astrophysical detections. Between science runs, all recent ' +
  'GraceDB superevents may be mock; always check the mock flag before ' +
  'treating an event as real.';

// GPS epoch → Unix epoch offset (GPS was 19 s ahead of UTC at the epoch).
const GPS_UNIX_OFFSET_S = 315964800 - 19;

/** GPS seconds → ISO-8601 UTC. Throws on non-finite input. */
export function gpsToIso(gpsSeconds) {
  const gps = Number(gpsSeconds);
  if (!Number.isFinite(gps) || gps <= 0) throw new Error('gracedb_bad_gps');
  return new Date((gps + GPS_UNIX_OFFSET_S) * 1000).toISOString();
}

/** Parse GraceDB's "2026-09-27 21:28:50 UTC" created strings. Null when unparsable. */
export function parseGraceCreated(created) {
  if (typeof created !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})\s*UTC$/i.exec(
    created.trim(),
  );
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

/**
 * Classify one superevent as mock or not. Mock when the API's own category
 * is MDC, or the superevent id carries the MDC naming pattern (MS…).
 */
export function isMockSuperevent(event) {
  if (event?.category === 'MDC')
    return { mock: true, reason: 'category is "MDC"' };
  if (/^MS/i.test(event?.superevent_id ?? '')) {
    return {
      mock: true,
      reason: 'superevent_id matches the MDC naming pattern (MS…)',
    };
  }
  return { mock: false, reason: null };
}

/**
 * Map one raw superevent to the public shape. Throws {status:502} when the
 * record is missing its identity fields.
 */
export function mapSuperevent(event) {
  const id = event?.superevent_id;
  if (typeof id !== 'string' || !id) {
    throw Object.assign(
      new Error('gracedb_bad_record: missing superevent_id'),
      { status: 502 },
    );
  }
  const { mock, reason } = isMockSuperevent(event);
  const preferred = event?.preferred_event_data;
  let tIso = null;
  try {
    if (event?.t_0 != null) tIso = gpsToIso(event.t_0);
  } catch {
    tIso = null;
  }
  const instruments = preferred?.instruments;
  return {
    id,
    mock,
    mockReason: reason,
    category: event?.category ?? null,
    tGps: Number.isFinite(Number(event?.t_0)) ? Number(event.t_0) : null,
    tIso,
    tNote: 't_0 is reported in GPS seconds; tIso is the converted UTC instant',
    created: parseGraceCreated(event?.created),
    far: Number.isFinite(Number(event?.far)) ? Number(event.far) : null,
    farNote:
      'false alarm rate, Hz (mock injections carry pipeline FARs, not astrophysical significance)',
    labels: Array.isArray(event?.labels) ? event.labels : [],
    preferredPipeline: preferred?.pipeline ?? null,
    preferredGroup: preferred?.group ?? null,
    instruments: typeof instruments === 'string' ? instruments : null,
    url: `https://gracedb.ligo.org/superevents/${id}/view/`,
  };
}

async function fetchSuperevents(fetchImpl, n) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(SUPEREVENTS_URL(n), {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`gracedb_http_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw Object.assign(new Error('gracedb_bad_json'), { status: 502 });
    }
    if (!Array.isArray(doc?.superevents)) {
      throw Object.assign(
        new Error('gracedb_bad_shape: no superevents array'),
        { status: 502 },
      );
    }
    // OBSERVED 2026-09-27: GraceDB ignores the N query param and always
    // returns its default page (100). Slice client-side; MAX_N (50) keeps
    // the request inside a single page.
    return {
      total: Number.isFinite(Number(doc?.numRows)) ? Number(doc.numRows) : null,
      events: doc.superevents.slice(0, n).map(mapSuperevent),
    };
  } finally {
    clearTimeout(timer);
  }
}

function buildPayload(data, n, nowMs, stale) {
  const mockCount = data.events.filter((e) => e.mock).length;
  const realCount = data.events.length - mockCount;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale,
    requested: n,
    total: data.total,
    returned: data.events.length,
    mockCount,
    realCount,
    allRecentAreMock:
      data.events.length > 0 && mockCount === data.events.length,
    disclaimer: DISCLAIMER,
    events: data.events,
    attribution:
      'Gravitational-wave superevents: GraceDB, LIGO Scientific Collaboration (open data).',
  };
}

const cache = new Map(); // n -> {at, payload}
let inflight = null; // {n, promise}
const attemptedAt = new Map(); // n -> ms

async function getPayload(fetchImpl, n, nowMs, signal) {
  // nowMs is the injected clock (tests control it); real Date.now() is never
  // used for cache age so staleness is deterministic under test.
  const hit = cache.get(n);
  if (hit && nowMs - hit.at < CACHE_TTL_MS)
    return buildPayload(hit.payload, n, nowMs, false);
  signal?.throwIfAborted?.();
  if (!inflight || inflight.n !== n) {
    const last = attemptedAt.get(n) ?? -Infinity;
    if (nowMs - last < RETRY_COOLDOWN_MS)
      throw new Error('gracedb_retry_later');
    attemptedAt.set(n, nowMs);
    const promise = fetchSuperevents(fetchImpl, n)
      .then((data) => {
        cache.set(n, { at: nowMs, payload: data });
        return buildPayload(data, n, nowMs, false);
      })
      .finally(() => {
        if (inflight?.n === n) inflight = null;
      });
    inflight = { n, promise };
  }
  const pending = inflight.promise;
  if (!signal) return pending;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const detach = () => signal.removeEventListener('abort', abort);
    pending.then(detach, detach);
  });
  return Promise.race([pending, cancelled]);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

function parseN(raw) {
  if (raw === null) return DEFAULT_N;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_N) return null;
  return n;
}

export function gracedbProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let n = DEFAULT_N;
    try {
      const url = new URL(req.url, 'http://localhost');
      const raw = url.searchParams.get('n');
      if (raw !== null) {
        const parsed = parseN(raw);
        if (parsed === null)
          return sendJson(res, 400, { error: 'invalid_n' }, 'no-store');
        n = parsed;
      }
    } catch {
      return sendJson(res, 400, { error: 'invalid_query' }, 'no-store');
    }
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      try {
        sendJson(
          res,
          200,
          await getPayload(fetchImpl, n, now(), controller.signal),
        );
      } catch (error) {
        const hit = cache.get(n);
        const usable = hit && now() - hit.at <= STALE_MS;
        if (usable) {
          sendJson(res, 200, buildPayload(hit.payload, n, now(), true));
          return;
        }
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: 'gracedb_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'gracedb',
    configureServer({ middlewares }) {
      middlewares.use('/api/gracedb', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/gracedb', handler);
    },
  };
}

export const _gracedbInternals = {
  DEFAULT_N,
  MAX_N,
  gpsToIso,
  parseGraceCreated,
  isMockSuperevent,
  mapSuperevent,
  parseN,
  DISCLAIMER,
  clearCaches: () => {
    cache.clear();
    inflight = null;
    attemptedAt.clear();
  },
};
