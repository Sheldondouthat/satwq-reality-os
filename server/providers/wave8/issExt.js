/**
 * Wave 8 — open-notify ISS position + people-in-space (catalog Wave D item 71,
 * #74–75), with MANDATORY staleness guards.
 *
 * WHY THE GUARDS: the catalog marks both endpoints DEGRADED — iss-now.json is
 * intermittently unreachable ("intermittent 000") and astros.json was
 * observed serving a 2024-era crew roster on 2026-09-27 (Kononenko, Chub,
 * Dyson, Wilmore, Williams — people who are not on orbit now). Presenting
 * either as fresh would be a lie, so every payload carries per-section data
 * age and an explicit stale flag:
 *
 *   iss:   dataAgeMs = now - upstream timestamp; stale when the timestamp is
 *          older than 5 min (or impossibly in the future). Fresh ISS fixes
 *          arrive every few seconds, so 5 min is a generous bar.
 *   astros: upstream supplies NO timestamp, so we cannot compute true age —
 *          the payload says so, and flags stale=true when the roster matches
 *          the known 2024-era signature (≥2 of the 2024 crew names observed
 *          2026-09-27). The roster is returned as-is, never "corrected".
 *
 * One section may fail while the other succeeds: the endpoint then returns
 * 200 with that section marked ok:false (honest partial) instead of 502 —
 * but if BOTH fail, it 502s (honest upstream failure).
 *
 * Probe notes (2026-09-27, build VM): iss-now.json → 200 with a fresh
 * timestamp (1790545100); astros.json → first attempt returned nothing
 * (intermittent), retry returned the stale 2024 roster — both failure modes
 * the guards are built for were observed live.
 *
 * Routes:
 *   GET /api/iss-ext → { generatedAt, iss:{ok, latitude, longitude,
 *     upstreamTimestamp, dataAgeMs, stale, staleReason},
 *     astros:{ok, number, people:[{name,craft}], upstreamTimestampProvided,
 *     dataAgeMs, stale, staleReason}, partial, attribution }
 *
 * Keyless, open-notify (public), Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual'; 'error'
 * throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

import { readResponseTextCapped } from '../common/http.js';

const ISS_NOW_URL = 'http://api.open-notify.org/iss-now.json';
const ASTROS_URL = 'http://api.open-notify.org/astros.json';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 64 * 1024; // both endpoints are a few KB
const CACHE_TTL_MS = 60_000; // ISS position moves fast; 1-min cache
const STALE_MS = 10 * 60_000;
const RETRY_COOLDOWN_MS = 30_000;
const USER_AGENT = 'Gods Eye View (ISS extended layer)';

// Fresh ISS fixes arrive every few seconds; older than 5 min = stale.
const ISS_STALE_AGE_MS = 5 * 60_000;

// Crew names in the astros.json response observed on 2026-09-27 — a roster
// that predates the current expeditions (all flew in 2024). If ≥2 appear,
// the roster is treated as stale. This is a tripwire, not a crew database:
// the names are returned as-is regardless.
const STALE_CREW_SIGNATURES = [
  'Oleg Kononenko',
  'Nikolai Chub',
  'Tracy Caldwell Dyson',
  'Butch Wilmore',
  'Sunita Williams',
];
const STALE_CREW_HITS = 2;

let cache = null; // {at, payload}
let inflight = null;
let attemptedAt = -Infinity;

/**
 * Evaluate an iss-now.json document at nowMs. Pure + deterministic.
 * Throws {status:502} when the document is not a success-shaped payload.
 */
export function evaluateIssNow(doc, nowMs) {
  if (doc?.message !== 'success' || !doc?.iss_position) {
    throw Object.assign(new Error('iss_ext_bad_iss_now: unexpected payload'), {
      status: 502,
    });
  }
  const tsSec = Number(doc.timestamp);
  if (!Number.isFinite(tsSec) || tsSec <= 0) {
    throw Object.assign(new Error('iss_ext_bad_iss_now: no timestamp'), {
      status: 502,
    });
  }
  const latitude = Number(doc.iss_position.latitude);
  const longitude = Number(doc.iss_position.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    throw Object.assign(new Error('iss_ext_bad_iss_now: bad coordinates'), {
      status: 502,
    });
  }
  const upstreamTimestamp = new Date(tsSec * 1000).toISOString();
  const dataAgeMs = nowMs - tsSec * 1000;
  const stale = dataAgeMs > ISS_STALE_AGE_MS || dataAgeMs < -60_000;
  return {
    ok: true,
    latitude,
    longitude,
    upstreamTimestamp,
    dataAgeMs: Math.round(dataAgeMs),
    stale,
    staleReason: stale
      ? dataAgeMs < 0
        ? 'upstream timestamp is in the future — clock or data anomaly'
        : `position is ${Math.round(dataAgeMs / 1000)}s old (fresh ISS fixes arrive every few seconds)`
      : null,
  };
}

/**
 * Evaluate an astros.json document at nowMs. Pure + deterministic. Upstream
 * provides no timestamp, so data age is measured from our fetch time and
 * staleness is judged by the 2024-era crew signature.
 */
export function evaluateAstros(doc, fetchedAtMs, nowMs) {
  if (doc?.message !== 'success' || !Array.isArray(doc?.people)) {
    throw Object.assign(new Error('iss_ext_bad_astros: unexpected payload'), {
      status: 502,
    });
  }
  const people = doc.people
    .filter((p) => typeof p?.name === 'string' && typeof p?.craft === 'string')
    .map((p) => ({ name: p.name, craft: p.craft }));
  const hits = STALE_CREW_SIGNATURES.filter((sig) =>
    people.some((p) => p.name === sig),
  ).length;
  const stale = hits >= STALE_CREW_HITS;
  return {
    ok: true,
    number: Number.isFinite(Number(doc.number))
      ? Number(doc.number)
      : people.length,
    people,
    upstreamTimestampProvided: false,
    dataAgeMs: Math.round(nowMs - fetchedAtMs),
    stale,
    staleReason: stale
      ? `roster matches the 2024-era crew signature (${hits} of ${STALE_CREW_SIGNATURES.length} known 2024 names observed 2026-09-27) — upstream appears not to have updated; treat as reference, not current`
      : null,
  };
}

async function fetchJson(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`iss_ext_http_${res.status}_${url}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    try {
      return JSON.parse(text);
    } catch {
      throw Object.assign(new Error(`iss_ext_bad_json_${url}`), {
        status: 502,
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

function failedSection(source, error) {
  return {
    ok: false,
    stale: true,
    staleReason: `${source} unavailable: ${error?.message ?? 'unknown'}`,
    dataAgeMs: null,
  };
}

async function fetchBoth(fetchImpl, nowMs) {
  const fetchedAtMs = nowMs;
  const [issRes, astrosRes] = await Promise.allSettled([
    fetchJson(fetchImpl, ISS_NOW_URL),
    fetchJson(fetchImpl, ASTROS_URL),
  ]);
  let iss;
  let astros;
  if (issRes.status === 'fulfilled') {
    try {
      iss = evaluateIssNow(issRes.value, nowMs);
    } catch (error) {
      iss = failedSection('iss-now.json', error);
    }
  } else {
    iss = failedSection('iss-now.json', issRes.reason);
  }
  if (astrosRes.status === 'fulfilled') {
    try {
      astros = evaluateAstros(astrosRes.value, fetchedAtMs, nowMs);
    } catch (error) {
      astros = failedSection('astros.json', error);
    }
  } else {
    astros = failedSection('astros.json', astrosRes.reason);
  }
  if (!iss.ok && !astros.ok) {
    const err = new Error(
      `iss_ext_both_failed: iss=${iss.staleReason}; astros=${astros.staleReason}`,
    );
    err.status = 502;
    throw err;
  }
  return { iss, astros };
}

function buildPayload(sections, nowMs, stale) {
  const partial =
    !sections.iss.ok ||
    !sections.astros.ok ||
    sections.iss.stale ||
    sections.astros.stale;
  return {
    generatedAt: new Date(nowMs).toISOString(),
    partial,
    partialReason: partial
      ? 'One or more open-notify sections is stale or unavailable; each section carries its own ok/stale flags — never trust a section without checking them.'
      : null,
    stale,
    iss: sections.iss,
    astros: sections.astros,
    attribution:
      'ISS position + people in space: open-notify.org (public). ' +
      'The astros roster is known-stale as of 2026-09-27 — check astros.stale.',
  };
}

async function getPayload(fetchImpl, nowMs, signal) {
  // nowMs is the injected clock (tests control it); real Date.now() is never
  // used for cache age so staleness is deterministic under test.
  if (cache && nowMs - cache.at < CACHE_TTL_MS)
    return buildPayload(cache.payload, nowMs, false);
  signal?.throwIfAborted?.();
  if (!inflight) {
    if (nowMs - attemptedAt < RETRY_COOLDOWN_MS)
      throw new Error('iss_ext_retry_later');
    attemptedAt = nowMs;
    inflight = fetchBoth(fetchImpl, nowMs)
      .then((sections) => {
        cache = { at: nowMs, payload: sections };
        return buildPayload(sections, nowMs, false);
      })
      .finally(() => {
        inflight = null;
      });
  }
  if (!signal) return inflight;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const detach = () => signal.removeEventListener('abort', abort);
    inflight.then(detach, detach);
  });
  return Promise.race([inflight, cancelled]);
}

function sendJson(res, status, body, cacheControl = 'public, max-age=60') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

export function issExtProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      try {
        sendJson(
          res,
          200,
          await getPayload(fetchImpl, now(), controller.signal),
        );
      } catch (error) {
        const usable = cache && now() - cache.at <= STALE_MS;
        if (usable) {
          sendJson(res, 200, buildPayload(cache.payload, now(), true));
          return;
        }
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: 'iss_ext_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'issExt',
    configureServer({ middlewares }) {
      middlewares.use('/api/iss-ext', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/iss-ext', handler);
    },
  };
}

export const _issExtInternals = {
  ISS_NOW_URL,
  ASTROS_URL,
  ISS_STALE_AGE_MS,
  STALE_CREW_SIGNATURES,
  evaluateIssNow,
  evaluateAstros,
  clearCaches: () => {
    cache = null;
    inflight = null;
    attemptedAt = -Infinity;
  },
};
