/**
 * Wave 5 — leap-second / time-standard ticker (catalog Wave A item 20),
 * extended Wave C (item 62, #167/#169/#170) with Earth-orientation and
 * NTP-directory sources.
 *
 * WHY A PROXY: small machine-readable sources of truth for UTC↔TAI and
 * Earth orientation:
 *
 *  - IERS Bulletin C (XML): https://datacenter.iers.org/products/eop/bulletinc/xml/bulletinc-072.xml
 *    <UTC_TAI unit="s">-37</UTC_TAI> → TAI−UTC = 37 s. A scheduled leap
 *    would appear as an extra <UT> line with a future startDate.
 *  - IANA leap-seconds.list: https://data.iana.org/time-zones/data/leap-seconds.list
 *    last data line "3692217600 37 # 1 Jan 2017" → TAI−UTC = 37 s;
 *    "#@" line = file expiry; a future data line would be a scheduled leap.
 *  - IERS Bulletin C (text, #167 — parse fallback):
 *    https://datacenter.iers.org/products/eop/bulletinc/bulletinc-072.txt
 *    "…UTC-TAI = -37 s" and "NO leap second will be introduced at the end of
 *    December 2026." / "A positive leap second will be introduced…".
 *  - IERS EOP C04 (#169 — Earth orientation):
 *    https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now — 5.1 MB full
 *    series; fetched with `Range: bytes=-65536` (server honors it) so only
 *    the tail crosses the wire. Latest datum x/y pole, UT1−UTC, LOD.
 *    OBSERVED 2026-09-27: the file's last datum is 2026-08-28 (~30 d lag) —
 *    reported honestly via eop.lagDays, not papered over.
 *  - NIST ITS server list (#170 — NTP directory, NOT live NTP):
 *    https://tf.nist.gov/tf-cgi/servers.cgi — HTML table of
 *    name/IP/location/status. NIST ITS itself is NTP/Daytime-protocol, not
 *    HTTP; this source is the public server directory, labeled as such.
 *
 * GET /api/time →
 *   { generatedAt, taiMinusUtc, nextLeap, sources:[...], fileExpiry, stale,
 *     unavailable, reason, attribution, eop:{…}, nist:{…}, bulletinCText:{…} }
 *
 * The `sources` array keeps exactly the two leap-second sources (contract);
 * the three new sources are additive top-level sections, each with
 * status:'ok'|'error' — a failure in one never poisons the others.
 *
 * nextLeap is null when neither source announces one — that is the normal,
 * honest state, not an error. The two leap sources are cross-checked; a
 * disagreement is reported, not papered over (IERS wins, taiMinusUtc still
 * set, reason explains).
 *
 * Global fetch only; redirect:'follow' (workerd: 'error' throws at edge, main 2ec4053);
 * capped reads; timeouts; cache + inflight; no node: imports.
 */

import { readResponseTextCapped } from '../common/http.js';

const IERS_URL = 'https://datacenter.iers.org/products/eop/bulletinc/xml/bulletinc-072.xml';
const IANA_URL = 'https://data.iana.org/time-zones/data/leap-seconds.list';
const IERS_BULLETIN_C_TEXT_URL = 'https://datacenter.iers.org/products/eop/bulletinc/bulletinc-072.txt';
const IERS_EOP_C04_URL = 'https://hpiers.obspm.fr/iers/eop/eopc04/eopc04.1962-now';
const NIST_SERVERS_URL = 'https://tf.nist.gov/tf-cgi/servers.cgi';
const NTP_TO_UNIX = 2_208_988_800;

const FETCH_TIMEOUT_MS = 15_000;
const BODY_CAP = 256 * 1024;
const EOP_TAIL_BYTES = 65_536; // Range-request the tail of the 5.1 MB C04 series
const CACHE_TTL_MS = 24 * 60 * 60_000; // leap data changes ~never; EOP daily; refresh daily
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

/**
 * Parse the IERS Bulletin C plain-text edition (#167 — fallback for the XML).
 * Real format (probed 2026-09-27):
 *   "Paris, 06 July 2026" / "Bulletin C 72" /
 *   "NO leap second will be introduced at the end of December 2026." /
 *   "from 2017 January 1, 0h UTC, until further notice : UTC-TAI = -37 s"
 * A future leap would read "A positive leap second will be introduced at the
 * end of <Month YYYY>." Returns { bulletinNumber, bulletinDate, taiMinusUtc,
 * nextLeap }. Throws when the offset line is absent (not a Bulletin C text).
 */
export function parseIersBulletinCText(text) {
  const t = String(text);
  const pick = (re) => {
    const m = t.match(re);
    return m ? m[1].trim() : null;
  };
  const numberRaw = pick(/Bulletin C\s+(\d+)/);
  const bulletinNumber = numberRaw != null ? Number(numberRaw) : null;
  const bulletinDate = pick(/Paris,\s*(\d{1,2}\s+[A-Za-z]+\s+\d{4})/);
  const utcTaiRaw = pick(/UTC-TAI\s*=\s*(-?\d+)\s*s/);
  // NOTE: Number(null) === 0 is finite — null-check BEFORE Number(), or a
  // missing offset line silently parses as TAI−UTC = 0.
  if (utcTaiRaw == null) throw new Error('time_bulletinc_text_unparseable');
  const utcTai = Number(utcTaiRaw);
  if (!Number.isFinite(utcTai)) throw new Error('time_bulletinc_text_unparseable');
  const taiMinusUtc = -utcTai; // UTC-TAI = −37 → TAI−UTC = 37
  const leapDate = pick(/[Aa] positive leap second will be introduced at the end of ([A-Za-z]+ \d{4})/);
  const nextLeap = leapDate
    ? { date: leapDate, taiMinusUtc: taiMinusUtc + 1, announcedBy: 'iers-bulletin-c-text' }
    : null;
  return {
    bulletinNumber: bulletinNumber != null && Number.isFinite(bulletinNumber) ? bulletinNumber : null,
    bulletinDate,
    taiMinusUtc,
    nextLeap,
  };
}

/**
 * Parse the tail of the IERS EOP C04 series (#169 — Earth orientation).
 * Fixed-width/whitespace columns per data line:
 *   Year Month Day flag MJD x(") y(") UT1-UTC(s) LOD(ms) …
 * e.g. "2026   8  28   0  61280.00    0.212862    0.341472   0.0058921    0.000436 …"
 * Returns the LAST valid data line as { date, mjd, xArcsec, yArcsec,
 * ut1MinusUtc, lodMs, lineCount }. Throws when no data line is found.
 */
export function parseEopC04Tail(text) {
  let latest = null;
  let lineCount = 0;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const p = line.split(/\s+/);
    if (p.length < 9) continue;
    const year = Number(p[0]);
    const month = Number(p[1]);
    const day = Number(p[2]);
    const mjd = Number(p[4]);
    const xArcsec = Number(p[5]);
    const yArcsec = Number(p[6]);
    const ut1MinusUtc = Number(p[7]);
    const lodMs = Number(p[8]);
    if (
      !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
      !Number.isFinite(mjd) || !Number.isFinite(xArcsec) || !Number.isFinite(yArcsec) ||
      !Number.isFinite(ut1MinusUtc) || !Number.isFinite(lodMs)
    ) {
      continue;
    }
    lineCount += 1;
    latest = {
      date: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      mjd,
      xArcsec,
      yArcsec,
      ut1MinusUtc,
      lodMs,
    };
  }
  if (!latest) throw new Error('time_eopc04_no_data');
  return { ...latest, lineCount };
}

/**
 * Parse the NIST ITS server directory (#170) HTML table defensively.
 * Real shape (probed 2026-09-27): rows of 4 <td> cells —
 * [name, IP, location, status] — under a header row [Name, IP Address,
 * Location, Status]. Returns [{name, ip, location, status}] (possibly empty;
 * the caller decides whether empty is an error).
 */
export function parseNistServers(text) {
  const html = String(text);
  const servers = [];
  const cellText = (cell) =>
    cell
      .replace(/<[^>]*>/g, '')
      .replace(/&#160;|&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .trim();
  for (const m of html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...m[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => cellText(c[1]));
    if (cells.length < 4) continue;
    const [name, ip, location, status] = cells;
    if (!name || !/\./.test(name)) continue; // skips the header row and junk
    if (/^name$/i.test(name)) continue;
    servers.push({ name, ip, location, status });
  }
  return servers;
}

async function fetchText(fetchImpl, url, signal, timeoutMs = FETCH_TIMEOUT_MS, extraHeaders = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'application/xml, text/plain, */*', ...extraHeaders },
    });
    if (!res.ok) throw new Error(`time_upstream_http_${res.status}`);
    return readResponseTextCapped(res, BODY_CAP); // string; throws when too large
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

export async function buildTimeSnapshot({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  // Settle ONE source: captures fetch failures AND parser throws alike —
  // a parse error must degrade that source, never the whole snapshot.
  const settleParsed = (promise, parse) =>
    promise.then(
      (text) => {
        try {
          return { ok: true, parsed: parse(text) };
        } catch (error) {
          return { ok: false, error: error?.message ?? 'unknown' };
        }
      },
      (error) => ({ ok: false, error: error?.message ?? 'unknown' }),
    );
  const settled = await Promise.all([
    settleParsed(fetchText(fetchImpl, IERS_URL, null), parseIersBulletinC),
    settleParsed(fetchText(fetchImpl, IANA_URL, null), (text) => parseIanaLeapSeconds(text, now())),
    // Wave C item 62 — additive sources; each degrades independently.
    settleParsed(
      fetchText(fetchImpl, IERS_BULLETIN_C_TEXT_URL, null, FETCH_TIMEOUT_MS, { Accept: 'text/plain, */*' }),
      parseIersBulletinCText,
    ),
    settleParsed(
      fetchText(fetchImpl, IERS_EOP_C04_URL, null, FETCH_TIMEOUT_MS, {
        Range: `bytes=-${EOP_TAIL_BYTES}`,
        Accept: 'text/plain, */*',
      }),
      parseEopC04Tail,
    ),
    settleParsed(
      fetchText(fetchImpl, NIST_SERVERS_URL, null, FETCH_TIMEOUT_MS, { Accept: 'text/html, */*' }),
      parseNistServers,
    ),
  ]);
  const [iers, iana, bulletinCTextRes, eopRes, nistRes] = settled;
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

  // ——— Wave C item 62: additive sections, each degrades independently ———
  const bulletinCText = {
    status: bulletinCTextRes.ok ? 'ok' : 'error',
    source: 'iers-bulletin-c-text',
    bulletinNumber: bulletinCTextRes.ok ? bulletinCTextRes.parsed.bulletinNumber : null,
    bulletinDate: bulletinCTextRes.ok ? bulletinCTextRes.parsed.bulletinDate : null,
    taiMinusUtc: bulletinCTextRes.ok ? bulletinCTextRes.parsed.taiMinusUtc : null,
    nextLeap: bulletinCTextRes.ok ? bulletinCTextRes.parsed.nextLeap : null,
    error: bulletinCTextRes.ok ? null : bulletinCTextRes.error,
  };
  const eopLatest = eopRes.ok ? eopRes.parsed : null;
  const eopLagMs = eopLatest ? now() - Date.parse(eopLatest.date) : null;
  const eop = {
    status: eopRes.ok ? 'ok' : 'error',
    source: 'iers-eop-c04',
    latest: eopLatest
      ? {
          date: eopLatest.date,
          mjd: eopLatest.mjd,
          xArcsec: eopLatest.xArcsec,
          yArcsec: eopLatest.yArcsec,
          ut1MinusUtc: eopLatest.ut1MinusUtc,
          lodMs: eopLatest.lodMs,
        }
      : null,
    lagDays:
      eopLagMs != null && Number.isFinite(eopLagMs) ? Math.max(0, Math.round(eopLagMs / 86_400_000)) : null,
    error: eopRes.ok ? null : eopRes.error,
  };
  const nistServers = nistRes.ok ? nistRes.parsed : [];
  const nist = {
    status: nistRes.ok && nistServers.length > 0 ? 'ok' : 'error',
    source: 'nist-its-servers',
    serverCount: nistServers.length,
    servers: nistServers,
    note: 'NIST ITS itself is NTP/Daytime-protocol, not HTTP — this is the public server directory.',
    error: nistRes.ok ? (nistServers.length > 0 ? null : 'time_nist_no_servers') : nistRes.error,
  };

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
    bulletinCText,
    eop,
    nist,
    attribution:
      'Leap-second data: IERS Bulletin C (Paris Observatory) and IANA time-zones database. ' +
      'Earth orientation: IERS EOP C04. NTP server directory: NIST Internet Time Service server list.',
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
                bulletinCText: { status: 'error', source: 'iers-bulletin-c-text', taiMinusUtc: null, nextLeap: null, error: 'unreachable' },
                eop: { status: 'error', source: 'iers-eop-c04', latest: null, lagDays: null, error: 'unreachable' },
                nist: { status: 'error', source: 'nist-its-servers', serverCount: 0, servers: [], error: 'unreachable' },
                attribution:
                  'Leap-second data: IERS Bulletin C and IANA time-zones database. ' +
                  'Earth orientation: IERS EOP C04. NTP server directory: NIST Internet Time Service server list.',
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
  parseIersBulletinCText,
  parseEopC04Tail,
  parseNistServers,
  buildTimeSnapshot,
};
