/**
 * TESS exoplanet transit alerts — Track 3b item 3.5.
 *
 * Upstream: NASA Exoplanet Archive TAP (keyless ADQL), `toi` table:
 *   https://exoplanetarchive.ipac.caltech.edu/TAP/sync
 * DOC-VERIFIED 2026-09-27: keyless ADQL works; `toi` carries
 *   tid, toi, pl_orbper (days), pl_tranmid (BJD_TDB epoch), pl_trandurh (hours),
 *   pl_rade, ra, dec, st_tmag, tfopwg_disp.
 * Real columns verified live — note they are `ra`/`dec`, NOT `st_ra`/`st_dec`.
 *
 * Transit prediction is Kepler arithmetic: the next mid-transit after time T is
 *   t_next = epoch + ceil((T - epoch) / period) * period   (all in BJD_TDB)
 * BJD_TDB and UTC differ by light-travel time plus TT−UTC (~1 min), so
 * predicted times carry a "± few minutes" honesty label.
 *
 * Routes:
 *   GET /api/transits            → transits in the next 7 days (default)
 *   GET /api/transits?days=30    → window in days (1..90)
 *   GET /api/transits?limit=25   → cap on returned transits (1..200)
 *   on upstream failure → 503 {"error":"tess_unavailable"}
 *
 * Keyless. Pages-safe: global fetch only, capped reads, no node: imports,
 * no WASM, no `redirect:'error'`.
 *
 * @returns {import('vite').Plugin}
 */
const TAP_SYNC_URL = 'https://exoplanetarchive.ipac.caltech.edu/TAP/sync';

export const TRANSITS_ROUTE = '/api/transits';

const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024;
const CACHE_TTL_MS = 12 * 3600_000; // TOI ephemerides change slowly
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless TESS TOI transit context; contact: public repo)';
const HONESTY =
  'Transit times are Kepler predictions (epoch + n·period) from NASA Exoplanet ' +
  'Archive TOI ephemerides. pl_tranmid is BJD_TDB; conversion to UTC ignores ' +
  'light-travel/TT−UTC offsets, so predicted times are approximate to a few ' +
  'minutes. Candidate dispositions (PC/CP) are not confirmed planets.';

/** Build the ADQL query. `topN` bounds the upstream payload. */
export function buildToiAdql(topN = 500) {
  const n = Math.max(50, Math.min(2000, Math.floor(topN) || 500));
  return (
    `select top ${n} tid, toi, pl_orbper, pl_tranmid, pl_trandurh, pl_rade, ` +
    `ra, dec, st_tmag, tfopwg_disp from toi ` +
    `where tfopwg_disp in ('PC','CP') and pl_orbper>0 and pl_tranmid>0 and st_tmag<13`
  );
}

/** BJD_TDB → epoch milliseconds (treats BJD_TDB as UTC JD; ±few-min caveat documented). */
export function bjdToMs(bjd) {
  if (!Number.isFinite(bjd)) return null;
  return (bjd - 2440587.5) * 86400000;
}

export function msToBjd(ms) {
  if (!Number.isFinite(ms)) return null;
  return ms / 86400000 + 2440587.5;
}

/**
 * Next mid-transit (BJD_TDB) at or after `nowMs`, given epoch + period.
 * Pure Kepler: t = epoch + ceil((now - epoch)/period) * period.
 */
export function nextTransitBjd(epochBjd, periodDays, nowMs = Date.now()) {
  if (
    !Number.isFinite(epochBjd) ||
    !Number.isFinite(periodDays) ||
    periodDays <= 0 ||
    !Number.isFinite(nowMs)
  ) {
    return null;
  }
  const nowBjd = msToBjd(nowMs);
  const n = Math.ceil((nowBjd - epochBjd) / periodDays - 1e-9);
  return epochBjd + Math.max(0, n) * periodDays;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize one TAP CSV row into a transit prediction. Null on bad row. */
export function normalizeToiRow(row) {
  if (!row || typeof row !== 'object') return null;
  const periodDays = numOrNull(row.pl_orbper);
  const epochBjd = numOrNull(row.pl_tranmid);
  const ra = numOrNull(row.ra);
  const dec = numOrNull(row.dec);
  if (periodDays === null || epochBjd === null || ra === null || dec === null) {
    return null;
  }
  if (Math.abs(dec) > 90) return null;
  const nextBjd = nextTransitBjd(epochBjd, periodDays);
  const nextMs = bjdToMs(nextBjd);
  return {
    toi: String(row.toi ?? '').trim(),
    tid: numOrNull(row.tid),
    raDeg: ra,
    decDeg: dec,
    tmag: numOrNull(row.st_tmag),
    disposition: String(row.tfopwg_disp ?? '').trim(),
    periodDays,
    epochBjd,
    durationH: numOrNull(row.pl_trandurh),
    radiusRe: numOrNull(row.pl_rade),
    nextTransitBjd: nextBjd,
    nextTransitUtc: nextMs === null ? null : new Date(nextMs).toISOString(),
  };
}

/** Parse TAP CSV (header + quoted rows) into an array of objects. Pure. */
export function parseTapCsv(text) {
  if (typeof text !== 'string' || !text.length) return [];
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const pushField = () => {
    record.push(field);
    field = '';
  };
  const pushRecord = () => {
    rows.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushField();
      pushRecord();
    } else if (c === '\r') {
      // skip; \n handles the break
    } else {
      field += c;
    }
  }
  if (field !== '' || record.length) {
    pushField();
    pushRecord();
  }
  const nonEmpty = rows.filter((r) => r.some((f) => String(f).trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => String(h).trim());
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    for (let i = 0; i < header.length; i++) obj[header[i]] = r[i] ?? '';
    return obj;
  });
}

async function fetchToiCsv(fetchImpl, signal) {
  const body = new URLSearchParams({
    query: buildToiAdql(),
    format: 'csv',
  });
  const res = await fetchImpl(TAP_SYNC_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
      Accept: 'text/csv',
    },
    body: body.toString(),
    signal,
  });
  if (!res.ok) throw new Error(`TAP HTTP ${res.status}`);
  const reader = res.body?.getReader?.();
  let text = '';
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > BODY_CAP_BYTES) throw new Error('TAP payload exceeds cap');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } else {
    text = await res.text();
    if (text.length > BODY_CAP_BYTES)
      throw new Error('TAP payload exceeds cap');
  }
  if (/QUERY_STATUS.*"ERROR"|ORA-\d{5}/.test(text)) {
    throw new Error('TAP query error: ' + text.slice(0, 200));
  }
  return text;
}

export function tessProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ttlMs = CACHE_TTL_MS,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  /** @type {?{at:number, rows:any[]}} */
  let mem = null;
  let inflight = null;

  async function refreshUpstream() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const csv = await fetchToiCsv(fetchImpl, controller.signal);
      const rows = parseTapCsv(csv)
        .map(normalizeToiRow)
        .filter((r) => r && r.nextTransitUtc);
      if (!rows.length) throw new Error('TAP returned no usable TOI rows');
      return { at: Date.now(), rows };
    } finally {
      clearTimeout(timer);
    }
  }

  function refreshSingleFlight() {
    if (!inflight) {
      inflight = refreshUpstream().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use(TRANSITS_ROUTE, async (req, res) => {
      const sendJson = (status, bodyObj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bodyObj));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        const url = new URL(req.url || '/', 'http://localhost');
        const days = Math.max(
          1,
          Math.min(90, Number(url.searchParams.get('days')) || 7),
        );
        const limit = Math.max(
          1,
          Math.min(200, Number(url.searchParams.get('limit')) || 60),
        );
        const now = Date.now();
        if (!mem || now - mem.at > ttlMs) {
          try {
            mem = await refreshSingleFlight();
          } catch (err) {
            console.warn('[tess-proxy] upstream failed:', err?.message || err);
            if (!mem) {
              sendJson(503, { error: 'tess_unavailable' });
              return;
            }
          }
        }
        const horizonMs = now + days * 86400000;
        const transits = mem.rows
          .filter((r) => {
            const t = Date.parse(r.nextTransitUtc);
            return t >= now - 3600000 && t <= horizonMs;
          })
          .sort(
            (a, b) =>
              Date.parse(a.nextTransitUtc) - Date.parse(b.nextTransitUtc),
          )
          .slice(0, limit)
          .map((r) => ({
            ...r,
            hoursUntil: (Date.parse(r.nextTransitUtc) - now) / 3600000,
            tonight: Date.parse(r.nextTransitUtc) - now <= 24 * 3600000,
          }));
        sendJson(200, {
          generatedAt: new Date(mem.at).toISOString(),
          windowDays: days,
          count: transits.length,
          transits,
          honesty: HONESTY,
        });
      } catch (err) {
        console.error('[tess-proxy] request failed');
        sendJson(500, { error: 'tess proxy error' });
      }
    });
  };

  return {
    name: 'tess-transits-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
