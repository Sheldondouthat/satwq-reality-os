/**
 * Wave 6 — RMOB radio-meteor forward-scatter proxy (keyless).
 *
 * The Radio Meteor Observation Bulletin (RMOB) publishes per-station monthly
 * text files with hourly meteor echo counts (radio reflections off meteor
 * trails), used by the meteor forward-scatter community:
 *
 *   #57 https://www.rmob.org/livedata/live_datas/<Station>_<MMYYYY>rmob.TXT
 *
 * Real payload shape (OBSERVED 2026-09-28 from live files — the catalog's
 * documented "YYYY MM DD HH rows" layout was wrong and the old parser
 * matched nothing): a pipe-delimited MONTHLY MATRIX. Header row is the
 * month abbrev + 24 hour columns (`sep| 00h| 01h| ... | 23h|`); each data
 * row is a day-of-month followed by 24 hourly counts (` 01| 16 | 23 | ...`).
 * Cells may be blank or `???` (missing data — skipped, never zero-filled).
 * Files carry footer metadata lines ([Remarks], [Soft FTP], ...) which are
 * skipped. Year/month are NOT in the file — they come from the MMYYYY in
 * the request URL, so parseRmob takes the same `when` date as
 * stationFileUrl.
 *
 * Routes:
 *   GET /api/meteor-stations → {generatedAt, sources:{...}, count, stations:[...]}
 *
 * Each station file is parsed defensively: one hourly entry per (day, hour)
 * cell with a finite count. Per-station failures are recorded honestly in
 * `sources.<key>.error`; a 502 is returned only when EVERY station file fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 *
 * NOTE (2026-09-27): rmob.org was unreachable from the build VM (curl 000
 * timeouts — VM-throttled, needs a Worker-side probe). NOTE (2026-09-28):
 * reachable again (200); station list expanded from 1 to 67 after every
 * station's September 2026 file returned HTTP 200 with the matrix layout
 * above, each verified through the new parser.
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 60 * 60_000;
const MAX_HOURS = 24 * 40;
const USER_AGENT = 'Gods Eye View (public meteor forward-scatter context)';

// Cloudflare Workers (free tier) allows 50 subrequests per invocation; this
// provider fires one fetch per station, so STATIONS is capped at 40 to stay
// safely under the limit (OBSERVED 2026-09-28: 65 stations → the last 15
// failed in production with "Too many subrequests by single Worker invocation").
// The 40 are the most complete stations by 2026-09 row count (all verified
// 200 + parseable 2026-09-28). The other 25 verified stations are parked below
// in PARKED_STATIONS — re-verify and promote if the cap ever rises.
const STATIONS = [
  'LUNIGIANESI', 'Habraken', 'JHSPILKA-R1', 'Kano_1', 'Kano_2',
  'Szeged', 'ZEBRAK-R5', 'Barenschee', 'De_Queiroz', 'Essen_2',
  'F5CMQ_RMS', 'FLZ-R0', 'Heinz', 'Mckeel', 'Molne_RMS',
  'Norton', 'NortonVert', 'RamsObservatory', 'Tepliczky', 'Thibaut',
  'Wallbaum', 'Chris', 'Dubois', 'Klekociuk', 'Mario',
  'NACHODSKO-R5', 'OAUJ', 'Terrier_RMS', 'Essegi', 'Salvador',
  'Lauwerys', 'Sugimoto', 'Grimes', 'Verbelen', 'Associazione_Tuscolana_Astronomia',
  'Norman', 'Steyaert_SL5', 'GABB', 'DDMTREBIC-R4', 'Figueras',
]; // 40 stations; every 092026 file returned HTTP 200 and parsed to ≥1 hourly
   // record, 2026-09-28; OBSUPICE-R7/SVAKOV-R12/Thornett excluded (all-??? files)

// Verified-good 2026-09-28 but parked under the 50-subrequest Workers cap
// (2026-09 row counts in parentheses). Promote if the cap rises.
const PARKED_STATIONS = [
  'Henning', 'Institute', // 595
  'Druzynski', // 588
  'BI7NTP', // 560
  'RAINARD_SL', 'RAINARD', // 548, 546
  'Rourke', // 545
  'Fabio', // 537
  'Steyaert', // 523
  'Nelson7', // 513
  'Keresztesi', // 510
  'Rodriguez', // 498
  'JEN', // 490
  'McKeel', // 489 — note: would collide with 'Mckeel' source key; needs the _2 suffix logic if promoted
  'Kano_4', // 429
  'Nelson-A', // 426
  'Observatoire_SAT00', // 292
  'Latina', // 281
  'Wallbaum_2', // 279
  'Oakopal', // 260
  'LIBNATOV-R0', // 239
  'Otte', // 226
  'Gainey', // 153
  'BLONDEAU', // 95
  'METRA', // 87
];

function stationFileUrl(station, when = new Date()) {
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = when.getUTCFullYear();
  return `https://www.rmob.org/livedata/live_datas/${station}_${mm}${yyyy}rmob.TXT`;
}

// Source keys are case-collapsed, so McKeel/Mckeel would collide on
// 'rmob_mckeel' — disambiguate duplicates with a numeric suffix.
const _seenKeys = new Map();
function _sourceKey(station) {
  const base = `rmob_${station.toLowerCase()}`;
  const n = (_seenKeys.get(base) ?? 0) + 1;
  _seenKeys.set(base, n);
  return n === 1 ? base : `${base}_${n}`;
}

const SOURCES = STATIONS.map((station) => ({
  key: _sourceKey(station),
  station,
  attribution: 'RMOB — Radio Meteor Observation Bulletin (free, attribution)',
}));

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ——— parser (pure, exported for tests) ———

/** Parse one station's monthly matrix TXT into hourly (day, hour) entries.
 *
 * Real layout (OBSERVED 2026-09-28):
 *   sep| 00h| 01h| ... | 23h|        <- header: month abbrev + 24 hour cols
 *    01| 16 | 23 | ... | 11 |        <- day-of-month + 24 hourly counts
 * Blank cells and `???` are missing data (skipped, never zero-filled);
 * footer metadata lines ([Remarks], [Soft FTP], ...) carry no day number
 * and are skipped. Year/month come from `when` (the MMYYYY in the URL).
 */
export function parseRmob(station, text, when = new Date()) {
  const year = when.getUTCFullYear();
  const month = when.getUTCMonth() + 1;
  const lines = String(text ?? '').split(/\r?\n/);
  let hours = null; // hour-of-day per data column, from the header
  const hourly = [];
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.includes('|')) continue;
    const cells = line.split('|');
    if (!hours) {
      // Header candidate: at least one cell looks like `00h`..`23h`.
      const found = [];
      for (const cell of cells) {
        const m = cell.trim().match(/^(\d{1,2})h$/i);
        found.push(m ? Number(m[1]) : null);
      }
      const usable = found.filter((h) => h !== null && h >= 0 && h <= 23);
      if (usable.length >= 12) {
        hours = found;
        continue;
      }
      // No hour labels anywhere yet — not the header, skip.
      continue;
    }
    const day = Number(cells[0].trim());
    if (!Number.isInteger(day) || day < 1 || day > 31) continue; // footer/meta row
    // Data cell i aligns with header cell i (header cell 0 is the day label).
    for (let i = 1; i < cells.length && i < hours.length; i++) {
      const hour = hours[i];
      if (hour === null || hour < 0 || hour > 23) continue;
      const rawCell = cells[i].trim();
      if (rawCell === '') continue; // blank cell → missing (Number('') is 0!)
      const value = Number(rawCell);
      if (!Number.isFinite(value)) continue; // '???' etc. → missing
      const time = new Date(Date.UTC(year, month - 1, day, hour, 0, 0));
      hourly.push({
        timeISO: time.toISOString(),
        count: value,
        bins: 1,
      });
    }
  }
  hourly.sort((a, b) => a.timeISO.localeCompare(b.timeISO));
  const trimmed = hourly.slice(-MAX_HOURS);
  return {
    station,
    code: station,
    count: trimmed.length,
    totalCount: trimmed.reduce((sum, h) => sum + h.count, 0),
    hourly: trimmed,
  };
}

// ——— fetching ———

async function fetchTextCapped(stationKey, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). rmob.org was VM-throttled
      // at build time, so follow is the safe edge default.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain, */*' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`meteors_${stationKey}_upstream_${response.status}`), { status: 502 });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`meteors_${stationKey}_upstream_too_large`), { status: 502 });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(source) {
  const started = Date.now();
  const when = new Date();
  try {
    const url = stationFileUrl(source.station, when);
    const text = await fetchTextCapped(source.key, url);
    const station = parseRmob(source.station, text, when);
    if (station.count === 0)
      throw Object.assign(new Error(`meteors_${source.key}_no_data`), { status: 502 });
    return {
      key: source.key,
      ok: true,
      count: station.count,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      station,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      count: 0,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      station: null,
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const stations = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    if (r.station) stations.push(r.station);
  }
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: stations.length,
    stations,
    source: 'RMOB — Radio Meteor Observation Bulletin (radio forward-scatter, keyless)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(SOURCES.map(fetchOneSource))
      .then((results) => {
        const ok = results.some((r) => r.ok);
        if (!ok) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`meteors_all_upstream_down: ${detail}`), { status: 502 });
        }
        const payload = buildSnapshot(results);
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

/** Mount the RMOB meteor forward-scatter proxy. Mirrors the felt provider shape. */
export function meteorsProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'meteors_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'meteor-stations',
    configureServer({ middlewares }) {
      middlewares.use('/api/meteor-stations', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/meteor-stations', handler);
    },
  };
}

export const _meteorsInternals = {
  parseRmob,
  stationFileUrl,
  buildSnapshot,
  stations: STATIONS,
  sources: SOURCES,
  clearCaches: () => { cache = null; inflight = null; },
};
