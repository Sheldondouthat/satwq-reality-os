/**
 * Wave 3 Track 2c / 2.15 — EiBi shortwave schedules: "on air now".
 *
 * Polls the EiBi A26-season schedule CSV
 * (http://eibispace.de/dx/sked-a26.csv — NOTE: plain HTTP; the HTTPS
 * variant returns an empty reply, verified 2026-09-27) and computes, for the
 * current UTC minute, which HF broadcasters are on the air: frequency,
 * time window, days of week, ITU country, station, language, target area,
 * transmitter-site code, persistence code, seasonal validity, and the
 * bracketed "last heard" log date (MMYY) where present.
 *
 * Column semantics verified against README.TXT (2026-09-27): field 8 is the
 * transmitter-SITE code (entry #8; header mislabels it "Remarks"), field 9
 * is the PERSISTENCE code (entry #9: 0=this season, 1=everlasting,
 * 4=winter-only, 5=summer-only, 6=part-season via Start/Stop, 8=inactive),
 * and Start/Stop are DDMM ("0401"=4th January) with [MMYY] log annotations.
 * There is NO power column in this CSV.
 *
 * The CSV carries NO transmitter coordinates (ITU column is the country,
 * verified against the file) — so globe markers are honest country-level
 * markers, never fabricated site pins. See INTEGRATION.md for the full
 * parsed shape (this document feeds W8's shortwave oracle).
 *
 * Keyless (EiBi lists are explicitly free to reuse per README.TXT),
 * plain fetch + text parse (workerd-safe). ~0.5 MB, refreshed each minute.
 */
import { createKeylessProxy, fetchUpstreamText } from './lib/proxy.js';

const URL = 'http://eibispace.de/dx/sked-a26.csv';
const USER_AGENT =
  'SATWQ-RealityOS/1.0 (EiBi public schedules; keyless; contact via repo)';
const SEASON = 'a26';

const CACHE_TTL_MS = 60_000; // "on air now" is minute-precision
const STALE_MS = 10 * 60_000;
const UPSTREAM_TIMEOUT_MS = 30_000;
const TEXT_CAP = 2 * 1024 * 1024;
const MAX_ONAIR = 400;

// Field positions (0-based) in the semicolon-delimited CSV.
const F_FREQ = 0;
const F_TIME = 1; // "HHMM-HHMM"
const F_DAYS = 2; // "" (daily) | "Mo-Sa" | "Fr-Su" | "SaSu" | "Th-Tu" ...
const F_ITU = 3;
const F_STATION = 4;
const F_LANG = 5;
const F_TARGET = 6;
const F_REMARKS = 7;
const F_POWER = 8;
const F_START = 9; // DDMM seasonal start, "" = always
const F_STOP = 10; // DDMM seasonal stop, "" = always

const DOW = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']; // by Date.getUTCDay()

/** Expand a Days cell to a Set of 0-6 (0=Sunday). Exported for tests. */
export function parseDaysCell(cell) {
  const s = String(cell ?? '').trim();
  if (!s) return new Set([0, 1, 2, 3, 4, 5, 6]); // empty = daily (per README)
  const idx = (tok) => DOW.indexOf(tok);
  const out = new Set();
  const addRange = (a, b) => {
    let i = a;
    for (;;) {
      out.add(i);
      if (i === b) break;
      i = (i + 1) % 7;
    }
  };
  const dash = s.indexOf('-');
  if (dash > 0) {
    const a = idx(s.slice(0, dash).trim());
    const b = idx(s.slice(dash + 1).trim());
    if (a >= 0 && b >= 0) addRange(a, b);
  } else {
    for (let i = 0; i + 2 <= s.length; i += 2) {
      const d = idx(s.slice(i, i + 2));
      if (d >= 0) out.add(d);
    }
  }
  return out.size ? out : new Set([0, 1, 2, 3, 4, 5, 6]);
}

/** "HHMM-HHMM" -> [startMin, endMin]; handles "0000-2400" and wrap. Exported for tests. */
export function parseTimeWindow(cell) {
  const m = /^(\d{3,4})-(\d{3,4})$/.exec(String(cell ?? '').trim());
  if (!m) return null;
  const toMin = (s) => {
    const p = s.padStart(4, '0');
    return +p.slice(0, 2) * 60 + +p.slice(2);
  };
  let start = toMin(m[1]);
  let end = toMin(m[2]);
  if (end >= 1440) end = 1440;
  return [start, end];
}

function inWindow(minOfDay, [start, end]) {
  if (end <= start) return minOfDay >= start || minOfDay < end; // wraps midnight
  return minOfDay >= start && minOfDay < end;
}

/** DDMM cell -> MM*100+DD for comparison; "" -> null. Exported for tests.
 *
 * Per README.TXT (entries #10/#11): "0401" = 4th January (DDMM). A date in
 * [brackets] is the MMYY of the most recent LOG ("[0212]" = last heard
 * February 2012) — informational only, never a season bound. So "3006[0725]"
 * ends 30 June (last logged July 2025), while a fully-bracketed cell like
 * "[0626]" carries NO season bound.
 */
export function parseSeasonDate(cell) {
  const unbracketed = String(cell ?? '')
    .replace(/\[[^\]]*\]/g, '')
    .trim();
  if (!/^\d{4}$/.test(unbracketed)) return null;
  const dd = +unbracketed.slice(0, 2);
  const mm = +unbracketed.slice(2);
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  return mm * 100 + dd;
}

/** Bracketed "last heard" log date (MMYY per README) -> { month, year } | null. */
export function parseLastHeard(cell) {
  const m = String(cell ?? '').match(/\[(\d{2})(\d{2})\]/);
  if (!m) return null;
  const month = +m[1];
  if (month < 1 || month > 12) return null;
  return { month, year: 2000 + +m[2] };
}

function inSeason(mmdd, start, stop) {
  if (start == null || stop == null) return true;
  if (stop < start) return mmdd >= start || mmdd <= stop; // wraps year end
  return mmdd >= start && mmdd <= stop;
}

/**
 * True when the entry is on air at `nowMs` (UTC). Exported for tests.
 *
 * Persistence (entry #9 per README): 8 = inactive (never on air); 4 = winter
 * season only; 5 = summer season only (northern-hemisphere convention:
 * winter = Oct–Mar, summer = Apr–Sep — documented assumption, since the
 * README does not name a hemisphere); 6 = part of this season (Start/Stop
 * cells apply); 0/1/2/3 = season-wide. Seasonal Start/Stop are
 * season-relative; empty = year-round.
 */
export function isOnAir(entry, nowMs = Date.now()) {
  const p = entry.persistence;
  if (p === 8) return false; // inactive entry
  const d = new Date(nowMs);
  const month = d.getUTCMonth() + 1;
  if (p === 4 && month >= 4 && month <= 9) return false; // winter-only
  if (p === 5 && (month >= 10 || month <= 3)) return false; // summer-only
  const window = parseTimeWindow(entry.time);
  if (!window) return false;
  const minOfDay = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (!inWindow(minOfDay, window)) return false;
  if (!parseDaysCell(entry.days).has(d.getUTCDay())) return false;
  const mmdd = month * 100 + d.getUTCDate();
  return inSeason(
    mmdd,
    parseSeasonDate(entry.start),
    parseSeasonDate(entry.stop),
  );
}

/** Normalize one CSV row to the canonical schedule shape. Exported for tests. */
export function normalizeEibiRow(fields) {
  if (!Array.isArray(fields) || fields.length < 8) return null;
  const freq = +String(fields[F_FREQ]).trim();
  if (!Number.isFinite(freq) || freq <= 0) return null;
  // Field 7: the CSV header says "Remarks" but the values are the
  // transmitter-SITE codes (README entry #8: single/double letters like
  // "b", "ka"); remark keywords (irr/tent/test/alt/usb) do not occur here.
  const persistence = /^\d+$/.test(String(fields[F_POWER]).trim())
    ? +String(fields[F_POWER]).trim()
    : null;
  return {
    freqKhz: Math.round(freq * 10) / 10,
    time: String(fields[F_TIME] ?? '').trim(),
    days: String(fields[F_DAYS] ?? '').trim(),
    itu: String(fields[F_ITU] ?? '')
      .trim()
      .toUpperCase(),
    station: String(fields[F_STATION] ?? '')
      .trim()
      .slice(0, 120),
    lang: String(fields[F_LANG] ?? '')
      .trim()
      .slice(0, 40),
    target: String(fields[F_TARGET] ?? '')
      .trim()
      .slice(0, 40),
    site: String(fields[F_REMARKS] ?? '')
      .trim()
      .slice(0, 40),
    persistence,
    powerKw: null, // NOTE: the "P" column is the persistence CODE (entry #9),
    // not power — README: 0=this season, 1=everlasting, 4/5=winter/summer
    // only, 6=part-season, 8=inactive. No power column exists in this CSV.
    start: String(fields[F_START] ?? '').trim(),
    stop: String(fields[F_STOP] ?? '').trim(),
    lastHeard: parseLastHeard(fields[F_STOP]),
  };
}

export function parseEibiCsv(text, nowMs = Date.now()) {
  const lines = String(text).split('\n');
  const entries = [];
  // Line 0 is the column-width header ("kHz:75;Time(UTC):93;...") — skip it.
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const e = normalizeEibiRow(line.split(';'));
    if (e) entries.push(e);
  }
  const onAir = entries.filter((e) => isOnAir(e, nowMs)).slice(0, MAX_ONAIR);
  const byItu = {};
  for (const e of onAir) byItu[e.itu] = (byItu[e.itu] ?? 0) + 1;
  return { total: entries.length, onAirCount: onAir.length, onAir, byItu };
}

export function eibiProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function fetchUpstream({ fetchImpl: f, signal, now: n }) {
    const text = await fetchUpstreamText(f, URL, {
      signal,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      textCap: TEXT_CAP,
      userAgent: USER_AGENT,
      accept: 'text/csv,text/plain',
    });
    const parsed = parseEibiCsv(text, n());
    return { fetchedAt: n(), season: SEASON, ...parsed };
  }

  function describe(payload, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source: 'EiBi shortwave schedules (A26 season) via local proxy',
      attribution:
        'Schedule data © Eike Bierwirth (EiBi), free for reuse per README.TXT. ' +
        'On-air computed server-side per UTC minute. Markers are country-level: ' +
        'the CSV carries no transmitter coordinates.',
      fetchedAt: payload?.fetchedAt ?? null,
      stale,
      unavailable: !payload,
      reason,
      season: payload?.season ?? SEASON,
      total: payload?.total ?? 0,
      onAirCount: payload?.onAirCount ?? 0,
      byItu: payload?.byItu ?? {},
      onAir: payload?.onAir ?? [],
    };
  }

  return createKeylessProxy({
    name: 'eibi',
    route: '/api/eibi',
    ttlMs: CACHE_TTL_MS,
    staleMs: STALE_MS,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    fetchUpstream,
    describe,
    fetchImpl,
    now,
  });
}
