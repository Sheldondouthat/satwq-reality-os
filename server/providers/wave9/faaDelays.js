/**
 * Wave 9 (R2-13) — FAA airport delays / NAS status provider.
 *
 * Backlog R2-13 ("FAA airport delays"): "ASWS free. Zero in tree."
 * (wave3/tfr.js touches FAA TFR NOTAMs only — this is the delays feed.)
 *
 * Upstream (verified live 2026-10-02 from the build VM):
 *   https://nasstatus.faa.gov/api/airport-status-information → 200, XML
 *   (AIRPORT_STATUS_INFORMATION; the legacy services.faa.gov ASWS endpoint
 *   is 000/dead from this VM — deprecated, replaced by this NAS feed.)
 *   Real 2026-10-02 bytes: Update_Time "Fri Oct 2 11:46:31 2026 GMT",
 *   one Ground Delay Program (BOS, avg "1 hour and 5 minutes", max
 *   "3 hours and 4 minutes", reason "runway construction"), two Airport
 *   Closures (LAX transient-GA closure, PHL wingspan restriction).
 *
 * Routes:
 *   GET /api/faa-delays            → all active NAS delay sections (1 subreq)
 *   GET /api/faa-delays?airport=KJFK → that airport's rows across sections
 *   ?airport=<unknown-but-wellformed> → 200 {requestedNotFound:true}
 *     (nexrad/goes/pollen/hab/usace/great-lakes/ocearch pattern)
 *   bad airport code → 400
 *
 * 10-min TTL (the NAS document refreshes when programs change) + 7d
 * key-scoped stale fallback; all-dark document (zero active programs) is
 * honest 200 with empty sections — never a 502, never synthesized.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

const UPSTREAM_URL = 'https://nasstatus.faa.gov/api/airport-status-information';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 256 * 1024; // observed ~1 KB; storm days can be large
const CACHE_TTL_MS = 10 * 60_000;
const STALE_MS = 7 * 24 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const USER_AGENT = 'satwq-reality-os/1.0 (gods-eye-view; faa-delays layer; keyless)';
const CACHE_CONTROL = 'public, max-age=600';

const AIRPORT_RE = /^[A-Z0-9]{3,4}$/;

/** Decode the XML entities FAA actually emits in this feed. */
export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return Number.isFinite(n) ? String.fromCharCode(n) : `&#${d};`;
    });
}

/** First <Tag>…</Tag> text in `text`, or null. Pure, exported for tests. */
export function firstTag(text, tag) {
  const m = String(text ?? '').match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`));
  return m ? decodeEntities(m[1].trim()) : null;
}

/** All <Tag>…</Tag> inner bodies in `text`, in order. Pure. */
export function allBlocks(text, tag) {
  const out = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) out.push(m[1]);
  return out;
}

/**
 * Parse the NAS status XML into {updateTime, sections:[{name, itemTag, items:[{airport, fields}]}]}.
 * Generic over Delay_type sections (Ground Delay Programs, Ground Stops,
 * Arrival Departure Delays, Airport Closures, Deicing, Airspace Flow
 * Programs, …): whatever <X_List> blocks the FAA publishes parse through.
 * Item field values are carried VERBATIM as strings (e.g. Avg "1 hour and
 * 5 minutes") — no invented numerics. Fields whose raw value still contains
 * '<' (nested markup, not observed in live bytes) are dropped, never half-parsed.
 * Pure, exported for tests.
 */
export function parseNasStatus(xml) {
  const text = String(xml ?? '');
  const updateTime = firstTag(text, 'Update_Time');
  const sections = [];
  for (const block of allBlocks(text, 'Delay_type')) {
    const name = firstTag(block, 'Name');
    const listMatch = block.match(/<([A-Za-z_]+_List)>([\s\S]*?)<\/\1>/);
    if (!listMatch) continue; // unknown Delay_type shape — skipped, never guessed
    const listBody = listMatch[2];
    // The item element is the list body's first child element — NOT the list
    // tag minus "_List" ("Airport_Closure_List" holds <Airport> items; the
    // naive strip gives "Airport_Closure" and silently drops every closure).
    const itemTagMatch = listBody.match(/<([A-Za-z_]+)>/);
    if (!itemTagMatch) continue;
    const itemTag = itemTagMatch[1];
    const items = [];
    for (const itemBody of allBlocks(listBody, itemTag)) {
      const arptRaw = firstTag(itemBody, 'ARPT');
      const airport = arptRaw ? arptRaw.trim().toUpperCase() : null;
      if (!airport) continue; // a delay row without an airport is not addressable
      const fields = {};
      const re = /<([A-Za-z_]+)>([\s\S]*?)<\/\1>/g;
      let m;
      while ((m = re.exec(itemBody)) !== null) {
        const key = m[1];
        if (key === 'ARPT') continue;
        const value = decodeEntities(m[2].trim());
        if (value.includes('<')) continue; // nested markup — skip, never half-parse
        fields[key] = value;
      }
      items.push({ airport, fields });
    }
    sections.push({ name: name || 'Unnamed delay type', itemTag, items });
  }
  return { updateTime, sections };
}

/** Age of the FAA Update_Time in minutes, best-effort (null when unparseable). Pure. */
export function updateAgeMinutes(updateTime, nowMs = Date.now()) {
  const t = Date.parse(updateTime || '');
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 60_000);
}

/**
 * Validate the query. Returns {mode:'all'|'airport', airport?}.
 * Throws {status:400} on malformed airport; unknown-but-wellformed codes
 * are NOT an error here — they surface as requestedNotFound at payload time.
 * Pure, for tests.
 */
export function parseQuery(query) {
  const raw = query.get('airport');
  if (raw == null || raw === '') return { mode: 'all' };
  const airport = raw.trim().toUpperCase();
  if (!AIRPORT_RE.test(airport)) throw Object.assign(new Error('faadelays_bad_airport'), { status: 400 });
  return { mode: 'airport', airport };
}

/** Filter every section's items to one airport. Pure. */
export function filterByAirport(sections, airport) {
  return sections.map((s) => ({
    ...s,
    items: s.items.filter((it) => it.airport === airport),
  }));
}

/** Count the total active items across sections. Pure. */
export function countItems(sections) {
  return sections.reduce((n, s) => n + s.items.length, 0);
}

/** Build the payload envelope. Pure apart from generatedAt. */
export function buildPayload(parsed, sel, stale, nowMs = Date.now()) {
  const sections = sel.mode === 'airport' ? filterByAirport(parsed.sections, sel.airport) : parsed.sections;
  const total = countItems(sections);
  const byType = {};
  for (const s of sections) byType[s.name] = (byType[s.name] || 0) + s.items.length;
  const airports = [...new Set(sections.flatMap((s) => s.items.map((it) => it.airport)))].sort();
  const ageMin = updateAgeMinutes(parsed.updateTime, nowMs);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale: Boolean(stale),
    source: 'FAA National Airspace System status — airport-status-information (keyless XML)',
    attribution: 'Data: Federal Aviation Administration (U.S. DOT).',
    units: { time: 'FAA as-published strings; updateTime verbatim from feed' },
    updateTime: parsed.updateTime,
    updateAgeMinutes: ageMin == null ? null : Math.round(ageMin * 10) / 10,
    query: sel.mode === 'airport' ? { airport: sel.airport } : { airport: null },
    summary: {
      sections: sections.length,
      items: total,
      byType,
      airports,
    },
    sections,
    honesty: {
      activeOnly: 'The FAA document lists ONLY currently-active delay programs, stops and closures. An absent Delay_type section means zero active programs of that kind at update time — not missing data.',
      verbatim: 'Delay durations and reasons (e.g. Avg "1 hour and 5 minutes") are the FAA\'s as-published strings, carried verbatim; no durations are derived or normalized.',
      closureReasons: 'Airport-closure reasons are the FAA\'s raw NOTAM-style text (ICAO date-time groups like 2605271826 are day/hour/minute UTC ranges, not parsed dates).',
      zeroIsReal: 'A document with zero active items returns 200 with empty sections — a quiet sky is real data, never a 502.',
    },
  };
}

// --- fetch machinery (wave9 conventions) ---

async function fetchTextCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/xml, text/xml, */*' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`faadelays_upstream_${response.status}`), { status: 502 });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('faadelays_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(new Error(`faadelays_fetch_failed: ${error?.message ?? 'unknown'}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

// --- caches (per query key, mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;
const PAYLOAD_CACHE_MAX = 16;

function queryKey(sel) {
  return sel.mode === 'airport' ? `airport:${sel.airport}` : 'all';
}

async function getPayload(sel) {
  const key = queryKey(sel);
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { payload: hit.payload, stale: false };
  let op = inflight.get(key);
  if (!op) {
    if (now - docFailedAt < RETRY_COOLDOWN_MS && hit && now - hit.at < STALE_MS) {
      return { payload: hit.payload, stale: true };
    }
    op = (async () => {
      const xml = await fetchTextCapped(UPSTREAM_URL, BODY_CAP_BYTES);
      const parsed = parseNasStatus(xml);
      if (sel.mode === 'airport' && countItems(filterByAirport(parsed.sections, sel.airport)) === 0) {
        // NOT an upstream failure — this airport simply has no active NAS
        // programs right now (the feed lists active-only). Never a 404,
        // never synthesized rows (requestedNotFound pattern).
        return { notFound: true, airport: sel.airport };
      }
      const payload = buildPayload(parsed, sel, false);
      if (payloadCache.size >= PAYLOAD_CACHE_MAX) payloadCache.delete(payloadCache.keys().next().value);
      payloadCache.set(key, { at: Date.now(), payload });
      return { payload, stale: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = CACHE_CONTROL) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 FAA airport-delays (NAS status) proxy. */
export function faaDelaysProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let sel;
    try {
      sel = parseQuery(new URL(req.url, 'http://localhost').searchParams);
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: error.message }, 'no-store');
    }
    try {
      const { payload, stale, notFound, airport } = await getPayload(sel);
      if (notFound) {
        return sendJson(res, 200, { generatedAt: new Date().toISOString(), requestedNotFound: true, airport }, 'no-store');
      }
      sendJson(res, 200, stale ? { ...payload, stale: true } : payload);
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'faadelays_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'faaDelays',
    configureServer({ middlewares }) {
      middlewares.use('/api/faa-delays', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/faa-delays', handler);
    },
  };
}

export const _faaDelaysInternals = {
  parseQuery,
  parseNasStatus,
  filterByAirport,
  countItems,
  buildPayload,
  updateAgeMinutes,
  decodeEntities,
  firstTag,
  allBlocks,
  UPSTREAM_URL,
  clearCaches: () => { payloadCache.clear(); inflight.clear(); docFailedAt = -Infinity; },
};
