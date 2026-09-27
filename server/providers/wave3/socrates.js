/**
 * SOCRATES Plus conjunction-theater proxy — Track 3a item 3.3.
 *
 * Upstream: https://celestrak.org/SOCRATES/sort-minRange.csv (VERIFIED LIVE
 * 2026-09-27: HTTP 200, ~20.9 MB. Actual header is the MACHINE family:
 *   NORAD_CAT_ID_1,OBJECT_NAME_1,DSE_1,NORAD_CAT_ID_2,OBJECT_NAME_2,DSE_2,
 *   TCA,TCA_RANGE,TCA_RELATIVE_SPEED,MAX_PROB,DILUTION
 * Sorted by minimum range ascending: three-times-daily screening of active
 * payloads vs the full catalog for ≤5 km conjunctions over the next 7 days,
 * with TCA, miss distance, relative speed, and maximum collision probability
 * (Alfano method). OBSERVED 2026-09-27: the top of the file is dominated by
 * same-constellation pairs (Starlink self-conjunctions at 0.003 km, p=1.0) —
 * the proxy reports them faithfully; the consumer labels them by name.
 *
 * Routes:
 *   GET /api/conjunctions          → top 40 near-misses, TLE-enriched top 6
 *   GET /api/conjunctions?max=10   → 1..40 events
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped reads,
 * no node: imports, no WASM, no `redirect:'error'` — workerd rejects it).
 * CelesTrak 403s bulk/anonymous fetches, so every upstream request carries a
 * descriptive User-Agent (same etiquette as the repo's celestrak proxy).
 * Cache TTL 8h (SOCRATES runs 3×/day); stale served on upstream failure.
 *
 * Physics-honesty: SGP4-based screening on public GP data; maximum
 * probability is a conservative risk proxy, not a true collision probability.
 */

import { readCappedResponseText } from '../common/http.js';

const CSV_URL = 'https://celestrak.org/SOCRATES/sort-minRange.csv';
// Head-request size for the SOCRATES CSV (sorted by min range ascending).
const CSV_HEAD_BYTES = 262144;
// Snapshot: CelesTrak tarpits Cloudflare edge IPs on the SOCRATES CSV,
// so the provider prefers the GitHub-release snapshot (refreshed every 6h
// by scripts/conjunctions-snapshot.mjs) with live fetch as fallback.
const SNAPSHOT_URL =
  'https://github.com/Sheldondouthat/satwq-reality-os/releases/download/conjunctions-latest/conjunctions.json';
const SNAPSHOT_TIMEOUT_MS = 20_000;
const SNAPSHOT_MAX_BYTES = 4 * 1024 * 1024;
const TLE_URL = (catnr) =>
  `https://celestrak.org/NORAD/elements/gp.php?CATNR=${encodeURIComponent(catnr)}&FORMAT=tle`;
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 32 * 1024 * 1024; // live file was 20.9 MB on 2026-09-27
const CACHE_TTL_MS = 8 * 3600_000;
const MAX_EVENTS = 40;
const TLE_ENRICH_TOP = 6;
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless SOCRATES conjunction context; contact: public repo)';
const HONESTY =
  'CelesTrak SOCRATES Plus: SGP4 screening of active payloads vs the full ' +
  'public catalog, ≤5 km at TCA, next 7 days. Maximum probability is a ' +
  'conservative risk proxy (Alfano method), not a true collision probability.';

/** RFC 4180 line split (quotes + escaped quotes). */
export function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const normHeader = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Header-driven column map. Accepts BOTH naming families:
 *   human:  "TCA (UTC)", "NORAD Catalog Number", "Name", "Days Since Epoch",
 *           "Min Range (km)", "Relative Speed (km/sec)", "Max Probability"
 *   machine (OBSERVED live 2026-09-27):
 *           "TCA", "NORAD_CAT_ID_1", "OBJECT_NAME_1", "DSE_1",
 *           "TCA_RANGE", "TCA_RELATIVE_SPEED", "MAX_PROB"
 * Returns null when the header lacks the fields we need
 * (format drift → caller 502s with a reason).
 */
export function mapSocratesColumns(header) {
  const cells = header.map(normHeader);
  const findAll = (re) => {
    const idx = [];
    cells.forEach((c, i) => { if (re.test(c)) idx.push(i); });
    return idx;
  };
  const pick = (re) => findAll(re)[0] ?? -1;
  const norads = findAll(/norad/);
  const names = findAll(/name/);
  const dses = findAll(/dayssinceepoch|^dse/);
  const col = {
    tca: pick(/^tca/),
    minRangeKm: pick(/minrange|tcarange/),
    relSpeedKms: pick(/relativespeed/),
    maxProb: pick(/maxprob/),
    norad1: norads[0] ?? -1,
    norad2: norads[1] ?? -1,
    name1: names[0] ?? -1,
    name2: names[1] ?? -1,
    dse1: dses[0] ?? -1,
    dse2: dses[1] ?? -1,
  };
  const ok = col.tca >= 0 && col.minRangeKm >= 0 && col.maxProb >= 0 &&
    col.norad1 >= 0 && col.norad2 >= 0 && col.name1 >= 0 && col.name2 >= 0;
  return ok ? col : null;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** "2026-09-28 14:22:10" → ISO UTC; null on garbage. */
export function parseTca(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(raw.trim());
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Strip CelesTrak ops-status suffix like "STARLINK-1234 [+]" → {name, ops}. */
export function splitOpsStatus(raw) {
  const s = String(raw ?? '').trim();
  const m = /^(.*?)\s*\[([^\]]*)\]\s*$/.exec(s);
  if (m) return { name: m[1].trim(), ops: m[2].trim() };
  return { name: s, ops: null };
}

/** Normalize one CSV row into a conjunction event. Null on bad row. */
export function normalizeConjunctionRow(cells, col) {
  const get = (i) => (i >= 0 && i < cells.length ? cells[i] : '');
  const tcaUtc = parseTca(get(col.tca));
  const minRangeKm = numOrNull(get(col.minRangeKm));
  const maxProb = numOrNull(get(col.maxProb));
  if (tcaUtc === null || minRangeKm === null || maxProb === null) return null;
  if (minRangeKm > 5) return null; // SOCRATES wall: only ≤5 km is reported
  const n1 = splitOpsStatus(get(col.name1));
  const n2 = splitOpsStatus(get(col.name2));
  return {
    id: `socrates-${get(col.norad1)}-${get(col.norad2)}-${tcaUtc}`,
    tcaUtc,
    noradId1: String(get(col.norad1)).trim(),
    noradId2: String(get(col.norad2)).trim(),
    name1: n1.name, ops1: n1.ops,
    name2: n2.name, ops2: n2.ops,
    minRangeKm,
    relSpeedKms: numOrNull(get(col.relSpeedKms)),
    maxProb,
    dse1: numOrNull(get(col.dse1)),
    dse2: numOrNull(get(col.dse2)),
    tle1: null, tle2: null, // enriched below for the top events
  };
}

/** Parse a 3-line TLE set into {name, line1, line2}; null if unusable. */
export function parseTleSet(text) {
  if (typeof text !== 'string') return null;
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.length > 0);
  for (let i = 0; i < lines.length; i++) {
    if (/^1 \d{5}/.test(lines[i]) && /^2 \d{5}/.test(lines[i + 1] ?? '')) {
      const name = i > 0 && !/^[12] /.test(lines[i - 1]) ? lines[i - 1].trim() : '';
      return { name, line1: lines[i], line2: lines[i + 1] };
    }
  }
  return null;
}

async function fetchText(url, timeoutMs = UPSTREAM_TIMEOUT_MS, headOnly = false) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'text/csv,text/plain,*/*' };
    // The SOCRATES CSV is ~21 MB and sorted by min range ascending, so the
    // head holds the closest approaches. workerd isolates choke on the full
    // body, so we Range-request just the head (CelesTrak honors Range: 206).
    if (headOnly) headers.Range = `bytes=0-${CSV_HEAD_BYTES - 1}`;
    const res = await fetch(url, { signal: controller.signal, headers });
    if (!res.ok) throw Object.assign(new Error(`socrates_upstream_${res.status}`), { status: 502 });
    const { tooLarge, text } = await readCappedResponseText(res, BODY_CAP_BYTES);
    if (tooLarge) throw Object.assign(new Error('socrates_upstream_too_large'), { status: 502 });
    if (!headOnly) return text;
    // Trim a possibly-partial trailing line (Range cut, or a 200 that ignored Range).
    const head = text.length > CSV_HEAD_BYTES ? text.slice(0, CSV_HEAD_BYTES) : text;
    return head.slice(0, head.lastIndexOf('\n') + 1);
  } finally {
    clearTimeout(timer);
  }
}

/** Lazy line scanner — the SOCRATES CSV is ~21 MB; we only need the head. */
export function* scanLines(text) {
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf('\n', start);
    if (end === -1) end = text.length;
    yield text.slice(start, end);
    start = end + 1;
  }
}

/**
 * Parse the SOCRATES CSV head into conjunction events. The file is sorted by
 * min range ascending, so scanning stops once maxEvents are collected —
 * a 21 MB file never materializes as 230k line strings.
 * NOTE: header + rows are consumed in ONE for...of loop. Breaking out of a
 * loop over a generator closes it (IteratorClose / for...of semantics), so
 * a "find header, break, then keep scanning" pattern silently yields zero
 * rows. This function IS the production path — getEvents() calls it.
 */
export function parseSocratesCsv(text, maxEvents = MAX_EVENTS) {
  let col = null;
  const events = [];
  for (const raw of scanLines(text)) {
    if (!raw.trim()) continue;
    if (!col) {
      col = mapSocratesColumns(splitCsvLine(raw));
      if (!col) throw new Error('socrates_header_drift');
      continue;
    }
    if (events.length >= maxEvents) break;
    const ev = normalizeConjunctionRow(splitCsvLine(raw), col);
    if (ev) events.push(ev);
  }
  if (!col) throw new Error('socrates_upstream_empty');
  if (!events.length) throw new Error('socrates_upstream_unparseable');
  return events;
}

/** Mount the SOCRATES conjunction proxy. */
export function socratesProxy() {
  const caches = { list: null, enriched: null }; // { at, events }
  const inflight = { list: null, enriched: null };

  async function enrichTles(events) {
    const top = events.slice(0, TLE_ENRICH_TOP);
    const queue = [];
    for (const ev of top) {
      queue.push({ ev, slot: 'tle1', id: ev.noradId1 });
      queue.push({ ev, slot: 'tle2', id: ev.noradId2 });
    }
    const CONCURRENCY = 4;
    let cursor = 0;
    async function worker() {
      while (cursor < queue.length) {
        const job = queue[cursor++];
        try {
          const text = await fetchText(TLE_URL(job.id), 15_000);
          job.ev[job.slot] = parseTleSet(text);
        } catch {
          job.ev[job.slot] = null; // enrichment is opportunistic; list survives
        }
      }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  }

/** Fetch the pre-computed snapshot from the GitHub release. */
async function fetchSnapshot() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  try {
    const res = await fetch(SNAPSHOT_URL, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`snapshot HTTP ${res.status}`);
    const { tooLarge, text } = await readCappedResponseText(res, SNAPSHOT_MAX_BYTES);
    if (tooLarge) throw new Error('snapshot too large');
    const snap = JSON.parse(text);
    if (!Array.isArray(snap.events) || !snap.events.length)
      throw new Error('snapshot has no events');
    return snap.events.slice(0, MAX_EVENTS);
  } finally {
    clearTimeout(timer);
  }
}

  async function getEvents({ enrich = false } = {}) {
    // Separate caches: the fast list (no TLE) and the enriched theater feed.
    // The provider prefers the GitHub-release snapshot (CelesTrak tarpits
    // Cloudflare edge); live CSV fetch is the fallback. TLE enrichment
    // (12 upstream fetches) only runs when the caller opts in.
    const key = enrich ? 'enriched' : 'list';
    const nowMs = Date.now();
    if (caches[key] && nowMs - caches[key].at < CACHE_TTL_MS) return caches[key].events;
    if (inflight[key]) return inflight[key];
    inflight[key] = (async () => {
      try {
        let events;
        try {
          events = await fetchSnapshot();
        } catch {
          const text = await fetchText(CSV_URL, UPSTREAM_TIMEOUT_MS, true);
          events = parseSocratesCsv(text, MAX_EVENTS);
        }
        if (enrich) {
          try { await enrichTles(events); } catch { /* arcs degrade, list survives */ }
        }
        caches[key] = { at: Date.now(), events };
        return events;
      } catch (error) {
        if (caches[key]) return caches[key].events;
        throw error;
      } finally {
        inflight[key] = null;
      }
    })();
    return inflight[key];
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=28800' : 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' });
    let max = MAX_EVENTS;
    let enrich = false;
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const m = parsed.searchParams.get('max');
      if (m !== null) max = Math.min(MAX_EVENTS, Math.max(1, Math.floor(Number(m) || MAX_EVENTS)));
      enrich = parsed.searchParams.get('enrich') === '1';
    } catch {
      return sendJson(res, 400, { error: 'conjunctions_bad_request' });
    }
    try {
      const key = enrich ? 'enriched' : 'list';
      const events = (await getEvents({ enrich })).slice(0, max);
      const byProb = [...events].sort((a, b) => b.maxProb - a.maxProb).slice(0, 10).map((e) => e.id);
      sendJson(res, 200, {
        events,
        topByProbability: byProb,
        count: events.length,
        fetchedAt: new Date(caches[key].at).toISOString(),
        upstream: CSV_URL,
        honesty: HONESTY,
      });
    } catch (error) {
      const code = /header_drift/.test(error.message) ? 'conjunctions_format_drift' : 'conjunctions_upstream_unavailable';
      sendJson(res, 502, { error: code });
    }
  }

  return {
    name: 'socrates',
    configureServer({ middlewares }) {
      middlewares.use('/api/conjunctions', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/conjunctions', handler);
    },
  };
}
