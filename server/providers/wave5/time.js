/**
 * Wave 5 — leap-second / time-standard ticker (catalog Wave A item 20).
 *
 * WHY A PROXY: two small machine-readable sources of truth for UTC↔TAI:
 *
 *  - IERS Bulletin C (XML): https://datacenter.iers.org/products/eop/bulletinc/xml/bulletinc-072.xml
 *    <UTC_TAI unit="s">-37</UTC_TAI> → TAI−UTC = 37 s. A scheduled leap
 *    would appear as an extra <UT> line with a future startDate.
 *  - IANA leap-seconds.list: https://data.iana.org/time-zones/data/leap-seconds.list
 *    last data line "3692217600 37 # 1 Jan 2017" → TAI−UTC = 37 s;
 *    "#@" line = file expiry; a future data line would be a scheduled leap.
 *
 * GET /api/time →
 *   { generatedAt, taiMinusUtc, nextLeap, sources:[...], fileExpiry, stale,
 *     unavailable, reason, attribution }
 *
 * nextLeap is null when neither source announces one — that is the normal,
 * honest state, not an error. The two sources are cross-checked; a
 * disagreement is reported, not papered over (IERS wins, taiMinusUtc still
 * set, reason explains).
 *
 * Global fetch only; redirect:'follow' (workerd: 'error' throws at edge, main 2ec4053);
 * capped reads; timeouts; cache + inflight; no node: imports.
 */

import { readResponseTextCapped } from '../common/http.js';

const IERS_URL = 'https://datacenter.iers.org/products/eop/bulletinc/xml/bulletinc-072.xml';
const IANA_URL = 'https://data.iana.org/time-zones/data/leap-seconds.list';
const NTP_TO_UNIX = 2_208_988_800;

const FETCH_TIMEOUT_MS = 15_000;
const BODY_CAP = 256 * 1024;
const CACHE_TTL_MS = 24 * 60 * 60_000; // leap data changes ~never; refresh daily
const STALE_MS = 7 * 24 * 60 * 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const UA = 'GodsEyeView/1.0 (satwq-reality-os; public time-standard context)';

/**
 * Parse IERS Bulletin C XML with regexes (no XML lib — Pages-safe).
 * Returns { bulletinNumber, bulletinDate, taiMinusUtc, nextLeap, lines }.
 * nextLeap: { date, utcTai, announcedBy:'iers-bulletin-c' } | null.
 */
export function parseIersBulletinC(text) {
  const xml = String(text);
  const pick = (re) => {
    const m = xml.match(re);
    return m ? m[1].trim() : null;
  };
  const bulletinNumber = Number(pick(/<number>\s*(\d+)\s*<\/number>/));
  const bulletinDate = pick(/<data>\s*<date>\s*([^<]+?)\s*<\/date>/);
  const lines = [];
  for (const m of xml.matchAll(/<UT\b[^>]*>([\s\S]*?)<\/UT>/g)) {
    const body = m[1];
    const startDate = (body.match(/<startDate>\s*([^<]+?)\s*<\/startDate>/) || [])[1]?.trim() ?? null;
    const utcTai = Number((body.match(/<UTC_TAI[^>]*>\s*(-?\d+(?:\.\d+)?)\s*<\/UTC_TAI>/) || [])[1]);
    lines.push({ startDate, utcTai: Number.isFinite(utcTai) ? utcTai : null });
  }
  const bulletinMs = Date.parse(bulletinDate ?? '');
  const refMs = Number.isFinite(bulletinMs) ? bulletinMs : Date.now();
  const effective = lines.filter(
    (l) => l.startDate && Number.isFinite(Date.parse(l.startDate)) && Date.parse(l.startDate) <= refMs,
  );
  // The present offset is the latest line already in effect — NOT the last
  // line in the file, which may announce a FUTURE leap.
  const current = effective[effective.length - 1] ?? lines[0] ?? null;
  const taiMinusUtc = current?.utcTai != null ? -current.utcTai : null; // UTC_TAI is negative: −37 → TAI−UTC = 37
  const future = lines.filter(
    (l) => l.startDate && Number.isFinite(Date.parse(l.startDate)) && Date.parse(l.startDate) > refMs,
  );
  const nextLeap = future.length
    ? {
        date: future[0].startDate,
        utcTai: future[0].utcTai,
        taiMinusUtc: future[0].utcTai != null ? -future[0].utcTai : null,
        announcedBy: 'iers-bulletin-c',
      }
    : null;
  return {
    bulletinNumber: Number.isFinite(bulletinNumber) ? bulletinNumber : null,
    bulletinDate,
    taiMinusUtc,
    nextLeap,
    lines,
  };
}

/**
 * Parse the IANA leap-seconds.list text format.
 * Returns { taiMinusUtc, lastLeapDate, nextLeap, expiryMs, dataLines }.
 */
export function parseIanaLeapSeconds(text, nowMs = Date.now()) {
  const dataLines = [];
  let expiryMs = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    let m = line.match(/^#@\s+(\d+)/);
    if (m) {
      expiryMs = (Number(m[1]) - NTP_TO_UNIX) * 1000;
      continue;
    }
    m = line.match(/^(\d+)\s+(\d+)\s+#\s*(.+)$/);
    if (m) {
      dataLines.push({
        ntp: Number(m[1]),
        taiMinusUtc: Number(m[2]),
        date: m[3].trim(),
        ms: (Number(m[1]) - NTP_TO_UNIX) * 1000,
      });
    }
  }
  const last = dataLines[dataLines.length - 1] ?? null;
  const future = dataLines.filter((l) => l.ms > nowMs);
  return {
    taiMinusUtc: last ? last.taiMinusUtc : null,
    lastLeapDate: last ? last.date : null,
    nextLeap: future.length
      ? { date: future[0].date, taiMinusUtc: future[0].taiMinusUtc, announcedBy: 'iana-leap-seconds' }
      : null,
    expiryMs,
    dataLines: dataLines.length,
  };
}

async function fetchText(fetchImpl, url, signal, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/xml, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`time_upstream_http_${res.status}`);
    return readResponseTextCapped(res, BODY_CAP); // string; throws when too large
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function buildTimeSnapshot({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  const settled = await Promise.all([
    fetchText(fetchImpl, IERS_URL, null).then(
      (text) => ({ ok: true, parsed: parseIersBulletinC(text) }),
      (error) => ({ ok: false, error: error?.message ?? 'unknown' }),
    ),
    fetchText(fetchImpl, IANA_URL, null).then(
      (text) => ({ ok: true, parsed: parseIanaLeapSeconds(text, now()) }),
      (error) => ({ ok: false, error: error?.message ?? 'unknown' }),
    ),
  ]);
  const [iers, iana] = settled;
  const iersVal = iers.ok ? iers.parsed.taiMinusUtc : null;
  const ianaVal = iana.ok ? iana.parsed.taiMinusUtc : null;
  const agree = iersVal != null && ianaVal != null && iersVal === ianaVal;
  const taiMinusUtc = iersVal ?? ianaVal; // IERS is authoritative when they disagree
  const nextLeap = iers.ok && iers.parsed.nextLeap
    ? iers.parsed.nextLeap
    : iana.ok
      ? iana.parsed.nextLeap
      : null;
  const sources = [
    {
      id: 'iers-bulletin-c',
      name: 'IERS Bulletin C',
      status: iers.ok ? 'ok' : 'error',
      taiMinusUtc: iersVal,
      bulletinNumber: iers.ok ? iers.parsed.bulletinNumber : null,
      bulletinDate: iers.ok ? iers.parsed.bulletinDate : null,
      error: iers.ok ? null : iers.error,
    },
    {
      id: 'iana-leap-seconds',
      name: 'IANA leap-seconds.list',
      status: iana.ok ? 'ok' : 'error',
      taiMinusUtc: ianaVal,
      lastLeapDate: iana.ok ? iana.parsed.lastLeapDate : null,
      error: iana.ok ? null : iana.error,
    },
  ];
  const unavailable = taiMinusUtc == null;
  return {
    schemaVersion: 1,
    generatedAt: new Date(now()).toISOString(),
    taiMinusUtc,
    nextLeap,
    agreement: iers.ok && iana.ok ? (agree ? 'agree' : 'disagree') : 'single-source',
    sources,
    fileExpiry: iana.ok && iana.parsed.expiryMs ? new Date(iana.parsed.expiryMs).toISOString() : null,
    stale: false,
    unavailable,
    reason: unavailable
      ? 'Both time-standard sources unreachable.'
      : agree === false
        ? `IERS (${iersVal}) and IANA (${ianaVal}) disagree; using IERS value.`
        : null,
    attribution: 'Leap-second data: IERS Bulletin C (Paris Observatory) and IANA time-zones database.',
  };
}

export function timeProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  let cache = null;
  let inflight = null;
  let attemptedAt = -Infinity;

  async function acquire(signal) {
    if (cache && now() - cache.fetchedAt < CACHE_TTL_MS) {
      return { value: cache.value, stale: false };
    }
    signal?.throwIfAborted?.();
    if (!inflight) {
      if (now() - attemptedAt < RETRY_COOLDOWN_MS) throw new Error('time_retry_later');
      attemptedAt = now();
      inflight = buildTimeSnapshot({ fetchImpl, now })
        .then((value) => {
          cache = { value, fetchedAt: now() };
          return { value, stale: false };
        })
        .finally(() => { inflight = null; });
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

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      try {
        const { value, stale } = await acquire(controller.signal);
        json(200, { ...value, stale });
      } catch (error) {
        const usable = cache && now() - cache.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? { ...cache.value, stale: true, reason: 'Sources unreachable; showing last good reading.' }
            : {
                schemaVersion: 1,
                generatedAt: new Date(now()).toISOString(),
                taiMinusUtc: null,
                nextLeap: null,
                agreement: 'none',
                sources: [
                  { id: 'iers-bulletin-c', name: 'IERS Bulletin C', status: 'error', taiMinusUtc: null },
                  { id: 'iana-leap-seconds', name: 'IANA leap-seconds.list', status: 'error', taiMinusUtc: null },
                ],
                fileExpiry: null,
                stale: false,
                unavailable: true,
                reason: 'Time-standard sources unreachable and no cached reading exists.',
                attribution: 'Leap-second data: IERS Bulletin C and IANA time-zones database.',
              },
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'time',
    configureServer({ middlewares }) {
      middlewares.use('/api/time', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/time', handler);
    },
  };
}

export const _timeInternals = {
  parseIersBulletinC,
  parseIanaLeapSeconds,
  buildTimeSnapshot,
};
