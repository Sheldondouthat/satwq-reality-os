/**
 * Wave 8 — findu.com CWOP weather page (catalog Wave D item 70, #64) +
 * Priyom.org numbers-stations link-out (catalog #63).
 *
 * HONESTLY PARTIAL, two ways:
 *  1. findu exposes no machine API for this page — wxpage.cgi is an HTML page
 *     with a 3-minute meta refresh. The earlier raw.cgi path 404'd with
 *     "wrong hostname" (catalog note), so the HTML scrape is the only access
 *     method. Layout is best-effort: labels are regex-matched, not schema'd.
 *  2. Priyom.org has no machine API at all — it is a link-out (reference
 *     data, not live), never aggressively scraped.
 *
 * Probe notes (2026-09-27, build VM): wxpage.cgi?call=KD4PBS returned
 * HTTP 200 with "Sorry, no weather reports for KD4PBS..." — the page is live
 * but that callsign has no current reports. The provider therefore reports
 * availability state honestly (hasReports) instead of inventing weather, and
 * accepts ?call= to query a live station. One fetch per request (coalesced,
 * 10-min cache) — no hammering.
 *
 * Routes:
 *   GET /api/findu[?call=CALLSIGN] → { generatedAt, partial, partialReason,
 *     callsign, hasReports, fields:{…}, pageUrl, priyom:[{name,url,note}],
 *     attribution }
 *
 * Keyless, free, lawful (single polite fetch, 10-min cache, capped read),
 * Pages-safe (global fetch only, redirect:'follow' — workerd supports only
 * 'follow'/'manual'; 'error' throws at the edge (main 2ec4053), no node:
 * imports, no WASM).
 */

import { readResponseTextCapped } from '../common/http.js';

const WX_URL = (call) =>
  `http://www.findu.com/cgi-bin/wxpage.cgi?call=${encodeURIComponent(call)}`;
const DEFAULT_CALL = 'KD4PBS'; // catalog #64
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 256 * 1024; // wxpage is a few KB; 256 KB is headroom
const CACHE_TTL_MS = 10 * 60_000;
const STALE_MS = 6 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const USER_AGENT = 'Gods Eye View (findu CWOP weather layer)';

const PRIYOM_LINKS = [
  {
    name: 'Priyom.org — numbers stations reference',
    url: 'https://priyom.org/',
    note: 'Reference only: Priyom exposes no machine API, so this is a link-out, not live data.',
  },
];

const cache = new Map(); // callsign -> {at, payload}
let inflight = null; // {call, promise}
let attemptedAt = new Map(); // callsign -> ms

/**
 * Sanitize a user-supplied callsign for the query string: uppercase
 * alphanumerics and hyphens only, bounded length. Returns null on garbage.
 */
export function sanitizeCallsign(raw) {
  const s = String(raw ?? '')
    .toUpperCase()
    .trim();
  return /^[A-Z0-9-]{3,12}$/.test(s) ? s : null;
}

function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n');
}

/**
 * Parse a findu wxpage. Returns { hasReports, fields } where fields is a
 * best-effort label→value map (empty when the station has no reports or the
 * layout is unrecognized — callers must treat empty fields as "unknown", not
 * as zeroes). Pure + deterministic for tests.
 */
export function parseFinduWxpage(html, call) {
  const noReports = /Sorry, no weather reports for/i.test(html);
  const fields = {};
  if (!noReports) {
    const text = stripTags(html);
    const pick = (labelRe) => {
      const m = labelRe.exec(text);
      return m ? m[1].trim() : null;
    };
    // Best-effort label matches on the findu weather table; every field is
    // optional because the layout is not a contract.
    const temperature = pick(/Temperature\s*:?\s*([+-]?[\d.]+[^,\n]*)/i);
    const humidity = pick(/Humidity\s*:?\s*([+-]?[\d.]+[^,\n]*)/i);
    const pressure = pick(
      /(?:Pressure|Barometer)\s*:?\s*([+-]?[\d.]+[^,\n]*)/i,
    );
    const wind = pick(/Wind\s*:?\s*([^,\n]+(?:,\s*[^,\n]+)?)/i);
    const rain = pick(/Rain\s*:?\s*([+-]?[\d.]+[^,\n]*)/i);
    if (temperature) fields.temperature = temperature;
    if (humidity) fields.humidity = humidity;
    if (pressure) fields.pressure = pressure;
    if (wind) fields.wind = wind;
    if (rain) fields.rain = rain;
    const title = /Weather Conditions At ([A-Z0-9-]+)/i.exec(html);
    fields.reportedCallsign = title ? title[1].toUpperCase() : call;
  }
  return { hasReports: !noReports, fields };
}

async function fetchWxpage(fetchImpl, call) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(WX_URL(call), {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`findu_http_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    return parseFinduWxpage(text, call);
  } finally {
    clearTimeout(timer);
  }
}

const PARTIAL_REASON =
  "HTML scrape, no machine API: findu's wxpage.cgi is a human page with a " +
  '3-minute refresh; parsed fields are best-effort label matches, not a ' +
  'schema, and may be empty when a station has no reports. Priyom.org is a ' +
  'link-out only (no API exists).';

function buildPayload(parsed, call, nowMs, stale) {
  return {
    generatedAt: new Date(nowMs).toISOString(),
    partial: true,
    partialReason: PARTIAL_REASON,
    stale,
    callsign: call,
    hasReports: parsed.hasReports,
    fields: parsed.fields,
    fieldsNote: parsed.hasReports
      ? 'Best-effort scrape — empty fields mean the layout was not recognized, not that the value is zero.'
      : 'Station has no current weather reports; nothing to parse.',
    pageUrl: WX_URL(call),
    priyom: PRIYOM_LINKS,
    attribution:
      'Weather: findu.com CWOP/APRS (Steve Dimse). Numbers stations: Priyom.org (link-out, reference only).',
  };
}

async function getPayload(fetchImpl, call, nowMs, signal) {
  // nowMs is the injected clock (tests control it); real Date.now() is never
  // used for cache age so staleness is deterministic under test.
  const hit = cache.get(call);
  if (hit && nowMs - hit.at < CACHE_TTL_MS)
    return buildPayload(hit.payload, call, nowMs, false);
  signal?.throwIfAborted?.();
  if (!inflight || inflight.call !== call) {
    const last = attemptedAt.get(call) ?? -Infinity;
    if (nowMs - last < RETRY_COOLDOWN_MS) throw new Error('findu_retry_later');
    attemptedAt.set(call, nowMs);
    const promise = fetchWxpage(fetchImpl, call)
      .then((parsed) => {
        cache.set(call, { at: nowMs, payload: parsed });
        return buildPayload(parsed, call, nowMs, false);
      })
      .finally(() => {
        if (inflight?.call === call) inflight = null;
      });
    inflight = { call, promise };
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

export function finduProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let call = DEFAULT_CALL;
    try {
      const url = new URL(req.url, 'http://localhost');
      const raw = url.searchParams.get('call');
      if (raw !== null) {
        const clean = sanitizeCallsign(raw);
        if (!clean)
          return sendJson(res, 400, { error: 'invalid_callsign' }, 'no-store');
        call = clean;
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
          await getPayload(fetchImpl, call, now(), controller.signal),
        );
      } catch (error) {
        const hit = cache.get(call);
        const usable = hit && now() - hit.at <= STALE_MS;
        if (usable) {
          sendJson(res, 200, buildPayload(hit.payload, call, now(), true));
          return;
        }
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          { error: 'findu_unavailable', detail: error?.message ?? 'unknown' },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'findu',
    configureServer({ middlewares }) {
      middlewares.use('/api/findu', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/findu', handler);
    },
  };
}

export const _finduInternals = {
  DEFAULT_CALL,
  PRIYOM_LINKS,
  sanitizeCallsign,
  parseFinduWxpage,
  PARTIAL_REASON,
  clearCaches: () => {
    cache.clear();
    inflight = null;
    attemptedAt = new Map();
  },
};
