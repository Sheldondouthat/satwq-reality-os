/**
 * Wave 9 (R2-12) — OCEARCH shark tracker provider (Global Shark Tracker,
 * keyless, via Mapotic map 3413).
 *
 * Backlog R2-12 ("OCEARCH sharks"): "public tracker API, tagged white
 * sharks. Zero in tree." The tracker frontend is Mapotic-hosted
 * (map id 3413); its public JSON endpoints are what this provider reads:
 *
 * Upstream (verified live 2026-10-02 from the build VM):
 *   Roster (1 subrequest, ~434 KB geojson, 470 animals):
 *     https://www.mapotic.com/api/v1/maps/3413/pois.geojson/
 *     → {features:[{properties:{id,name,species,gender,stage_of_life,
 *        length,weight,tag_location,last_move_datetime,zping,
 *        zping_datetime,image}, geometry:{coordinates:[lon,lat]}}]}
 *   Per-animal track (1 subrequest/animal):
 *     https://www.mapotic.com/api/v1/maps/3413/pois/{id}/motion/with-meta/
 *     → {motion:[{dt_move, point:{coordinates:[lon,lat]}}], boundaries, center}
 *   Real bytes 2026-10-02: tiger shark "Toño" pinged 2026-09-30,
 *   white shark "Breton" pinged 2026-09-29 (1,244 motion rows, 2020→now);
 *   399 of 470 roster animals are sharks (the rest are sea turtles).
 *
 * Routes:
 *   GET /api/ocearch             → top 12 most-recently-pinged SHARKS (13 subreqs)
 *   GET /api/ocearch?n=24        → 1..24 sharks (1 + n subrequests, ≤25 total)
 *   GET /api/ocearch?animal=544541 → one animal's real track (2 subrequests)
 *   ?animal=<unknown-but-wellformed> → 200 {requestedNotFound:true}
 *     (nexrad/goes/pollen/hab/usace/great-lakes pattern)
 *   bad n / bad animal id → 400
 *
 * 6h TTL (pings arrive in bursts, months apart) + 7d key-scoped stale
 * fallback; per-animal fail-soft (motion miss → roster latest-point
 * fallback, never synthesized); all-dark → honest 502.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

const MAPOTIC_BASE = 'https://www.mapotic.com/api/v1';
const MAP_ID = 3413;
const ROSTER_URL = `${MAPOTIC_BASE}/maps/${MAP_ID}/pois.geojson/`;
const motionUrl = (poiId) => `${MAPOTIC_BASE}/maps/${MAP_ID}/pois/${poiId}/motion/with-meta/`;
export { motionUrl };
const UPSTREAM_TIMEOUT_MS = 20_000;
const ROSTER_BODY_CAP_BYTES = 1024 * 1024; // observed 434 KB; headroom
const MOTION_BODY_CAP_BYTES = 512 * 1024; // Breton: 155 KB for 1,244 rows
const CACHE_TTL_MS = 6 * 3600_000; // pings are sparse; burst cadence
const STALE_MS = 7 * 24 * 3600_000;
const RETRY_COOLDOWN_MS = 60_000;
const DEFAULT_N = 12;
const MAX_N = 24;
const PING_CAP = 80; // newest pings kept per animal (track shape, not all 1,244)
const FRESH_AGE_DAYS = 30; // pings can be months apart; ≤30d counts "fresh"
const SHARK_RE = /shark|mako|hammerhead/i; // roster species filter (turtles excluded)
const USER_AGENT = 'satwq-reality-os/1.0 (gods-eye-view; ocearch layer; keyless)';

/** Number(null)===0 guard: null/NaN/empty upstream numerics become null, never 0. */
export function numOrNull(v) {
  if (v == null) return null;
  if (typeof v === 'string' && v.trim() === '') return null; // Number('')===0 trap
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const ANIMAL_ID_RE = /^\d{1,12}$/;

/**
 * Validate the query. Returns {mode:'top'|'animal'|'notfound', n?, animalId?}.
 * Throws {status:400} on malformed input; unknown-but-wellformed animal ids
 * return {mode:'notfound'} (200 + requestedNotFound). Pure, for tests.
 */
export function parseQuery(query) {
  const rawAnimal = query.get('animal');
  if (rawAnimal != null && rawAnimal !== '') {
    if (!ANIMAL_ID_RE.test(rawAnimal)) throw Object.assign(new Error('ocearch_bad_animal'), { status: 400 });
    return { mode: 'animal', animalId: Number(rawAnimal) };
  }
  const rawN = query.get('n');
  let n = DEFAULT_N;
  if (rawN != null && rawN !== '') {
    if (!/^\d{1,3}$/.test(rawN)) throw Object.assign(new Error('ocearch_bad_n'), { status: 400 });
    n = Number(rawN);
    if (n < 1 || n > MAX_N) throw Object.assign(new Error('ocearch_bad_n'), { status: 400 });
  }
  return { mode: 'top', n };
}

/** Shark-scope filter — the Mapotic roster also tracks sea turtles; this layer is sharks only. */
export function isSharkSpecies(species) {
  return SHARK_RE.test(species || '');
}

/**
 * Pick the n most-recently-pinged sharks from a roster FeatureCollection.
 * Pure, exported for tests. Skips features with no properties, no
 * last_move_datetime, or a non-shark species; sorts newest-first.
 */
export function selectTopSharks(rosterJson, n) {
  const feats = Array.isArray(rosterJson?.features) ? rosterJson.features : [];
  const rows = [];
  for (const f of feats) {
    const p = f?.properties;
    if (!p) continue;
    if (!isSharkSpecies(p.species)) continue;
    if (!p.last_move_datetime) continue;
    rows.push(f);
  }
  rows.sort((a, b) => String(b.properties.last_move_datetime).localeCompare(String(a.properties.last_move_datetime)));
  return rows.slice(0, n);
}

/**
 * Find one animal in the roster by Mapotic poi id (sharks only).
 * Returns null when absent — caller answers requestedNotFound.
 */
export function findAnimal(rosterJson, animalId) {
  const feats = Array.isArray(rosterJson?.features) ? rosterJson.features : [];
  for (const f of feats) {
    const p = f?.properties;
    if (!p) continue;
    if (numOrNull(p.id) === animalId && isSharkSpecies(p.species)) return f;
  }
  return null;
}

/**
 * Parse a motion payload into newest-first-safe pings:
 * [{time, lat, lon}] ascending by dt_move, newest PING_CAP kept.
 * Rows with missing coords or dt_move are SKIPPED (never zero-filled —
 * 0,0 is the Gulf of Guinea, not a shark). Pure, exported for tests.
 */
export function parseMotion(motionJson) {
  const rows = Array.isArray(motionJson?.motion) ? motionJson.motion : [];
  const out = [];
  for (const m of rows) {
    const coords = m?.point?.coordinates;
    const lat = numOrNull(coords?.[1]);
    const lon = numOrNull(coords?.[0]);
    const time = typeof m?.dt_move === 'string' ? m.dt_move : null;
    if (lat == null || lon == null || !time) continue;
    out.push({ time, lat, lon });
  }
  out.sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
  return out.slice(-PING_CAP);
}

/** Age in days between an ISO instant and nowMs (fractional, ≥0). Pure. */
export function ageDays(isoTime, nowMs = Date.now()) {
  const t = Date.parse(isoTime);
  if (Number.isNaN(t)) return null;
  return Math.max(0, (nowMs - t) / 86_400_000);
}

/**
 * Build one animal's row from its roster feature + parsed pings.
 * trackSource: 'motion' when the real track parsed, 'roster-point' when
 * the motion fetch failed or parsed empty (the roster geometry point is
 * OCEARCH's own latest fix — a real coordinate, not a synthesis).
 */
export function buildAnimalRow(feature, pings, trackSource, nowMs = Date.now()) {
  const p = feature.properties || {};
  const coords = feature?.geometry?.coordinates;
  const rosterLat = numOrNull(coords?.[1]);
  const rosterLon = numOrNull(coords?.[0]);
  let finalPings = pings;
  let finalSource = trackSource;
  if (finalPings.length === 0 && rosterLat != null && rosterLon != null && p.last_move_datetime) {
    finalPings = [{ time: p.last_move_datetime, lat: rosterLat, lon: rosterLon }];
    finalSource = 'roster-point';
  }
  const last = finalPings.length ? finalPings[finalPings.length - 1] : null;
  const first = finalPings.length ? finalPings[0] : null;
  const pingAge = last ? ageDays(last.time, nowMs) : null;
  const spanDays = last && first ? ageDays(first.time, nowMs) - ageDays(last.time, nowMs) : null;
  return {
    id: numOrNull(p.id),
    name: typeof p.name === 'string' ? p.name : null,
    species: typeof p.species === 'string' ? p.species : null,
    gender: typeof p.gender === 'string' ? p.gender : null,
    stageOfLife: typeof p.stage_of_life === 'string' ? p.stage_of_life : null,
    length: typeof p.length === 'string' ? p.length : null,
    weight: typeof p.weight === 'string' ? p.weight : null,
    tagLocation: typeof p.tag_location === 'string' ? p.tag_location : null,
    photo: typeof p.image === 'string' && p.image ? p.image : null,
    zping: {
      flag: p.zping === true,
      datetime: typeof p.zping_datetime === 'string' ? p.zping_datetime : null,
    },
    ok: finalPings.length > 0,
    trackSource: finalSource,
    lastPing: last ? last.time : null,
    lastPingAgeDays: pingAge == null ? null : Math.round(pingAge * 10) / 10,
    fresh: pingAge != null && pingAge <= FRESH_AGE_DAYS,
    firstPing: first ? first.time : null,
    spanDays: spanDays == null ? null : Math.round(Math.max(0, spanDays) * 10) / 10,
    pingCount: finalPings.length,
    pings: finalPings,
  };
}

/** Build the full payload envelope. Pure apart from generatedAt. */
export function buildPayload(animals, rosterSharkCount, stale) {
  const ok = animals.filter((a) => a.ok);
  let freshestPing = null;
  for (const a of ok) {
    if (a.lastPing && (freshestPing == null || a.lastPing > freshestPing)) freshestPing = a.lastPing;
  }
  return {
    generatedAt: new Date().toISOString(),
    stale: Boolean(stale),
    source: 'OCEARCH Global Shark Tracker — SPOT-tag surfacing pings, via the public Mapotic map 3413 JSON endpoints (keyless)',
    attribution: 'Data: OCEARCH (nonprofit research organization); SPOT tags transmit a locating ping when the tagged fin breaks the surface. Map hosting: Mapotic.',
    units: { position: 'lat/lon decimal degrees (WGS84)', time: 'ISO 8601 UTC' },
    summary: {
      animals: animals.length,
      ok: ok.length,
      dark: animals.length - ok.length,
      fresh: ok.filter((a) => a.fresh).length,
      sharksInMap: rosterSharkCount,
      freshestPingUtc: freshestPing,
    },
    animals,
    honesty: {
      spotPings: 'A ping exists only when the tagged fin stayed above the surface long enough for the SPOT tag to transmit; months between location pings are normal — it is not a continuous GPS trail.',
      zping: 'A z-ping means the tag broke the surface but not long enough for a GPS fix — it carries NO location and is never counted as a position. The zping flag/datetime is surfaced from the roster as OCEARCH labels it.',
      straightLines: 'Consecutive pings are joined by straight segments; that line is NOT the animal\u2019s true path — anything can happen between two pings.',
      pingsCapped: `Per-animal tracks keep only the newest ${PING_CAP} pings (an active shark can carry 1,000+); pingCount is the capped count.`,
      sharksOnly: 'The Mapotic roster also tracks sea turtles; this layer is sharks-only by scope (species matching shark/mako/hammerhead) — turtles are excluded here, not absent upstream.',
      trackSource: '"motion" rows come from the per-animal track endpoint; "roster-point" rows are OCEARCH\u2019s own latest fix from the roster geometry (real coordinate, shown when the track fetch failed).',
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
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`ocearch_upstream_${response.status}`), { status: 502 });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('ocearch_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(new Error(`ocearch_fetch_failed: ${error?.message ?? 'unknown'}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, capBytes) {
  const text = await fetchTextCapped(url, capBytes);
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('ocearch_upstream_bad_json'), { status: 502 });
  }
}

// --- caches (per query key, mirroring wave9 conventions) ---
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
let docFailedAt = -Infinity;
const PAYLOAD_CACHE_MAX = 16;

function queryKey(sel) {
  if (sel.mode === 'animal') return `animal:${sel.animalId}`;
  return `top:${sel.n}`;
}

function countSharks(rosterJson) {
  const feats = Array.isArray(rosterJson?.features) ? rosterJson.features : [];
  let n = 0;
  for (const f of feats) if (isSharkSpecies(f?.properties?.species)) n++;
  return n;
}

async function fetchOneAnimal(feature) {
  const poiId = feature?.properties?.id;
  try {
    const motionJson = await fetchJson(motionUrl(poiId), MOTION_BODY_CAP_BYTES);
    const pings = parseMotion(motionJson);
    return buildAnimalRow(feature, pings, 'motion');
  } catch {
    // Motion fetch failed — honest fallback to the roster's latest fix.
    return buildAnimalRow(feature, [], 'roster-point');
  }
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
      const roster = await fetchJson(ROSTER_URL, ROSTER_BODY_CAP_BYTES);
      const sharksInMap = countSharks(roster);
      let features;
      if (sel.mode === 'animal') {
        const found = findAnimal(roster, sel.animalId);
        if (!found) {
          // NOT an upstream failure — just report the miss; never a 404,
          // never a synthesized animal (requestedNotFound pattern).
          return { notFound: true, animalId: sel.animalId };
        }
        features = [found];
      } else {
        features = selectTopSharks(roster, sel.n);
      }
      const animals = await Promise.all(features.map(fetchOneAnimal));
      const okCount = animals.filter((a) => a.ok).length;
      if (okCount === 0) {
        docFailedAt = Date.now();
        if (hit && now - hit.at < STALE_MS) return { payload: hit.payload, stale: true };
        throw Object.assign(new Error('ocearch_all_upstreams_failed'), { status: 502 });
      }
      const payload = buildPayload(animals, sharksInMap, false);
      if (payloadCache.size >= PAYLOAD_CACHE_MAX) payloadCache.delete(payloadCache.keys().next().value);
      payloadCache.set(key, { at: Date.now(), payload });
      return { payload, stale: false };
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=21600') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 OCEARCH shark-tracker proxy. */
export function ocearchProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    let sel;
    try {
      sel = parseQuery(new URL(req.url, 'http://localhost').searchParams);
    } catch (error) {
      return sendJson(res, error.status ?? 400, { error: error.message }, 'no-store');
    }
    try {
      const { payload, stale, notFound, animalId } = await getPayload(sel);
      if (notFound) {
        return sendJson(res, 200, { generatedAt: new Date().toISOString(), requestedNotFound: true, animal: animalId }, 'no-store');
      }
      sendJson(res, 200, stale ? { ...payload, stale: true } : payload);
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'ocearch_unavailable',
        detail: error?.message ?? 'unknown',
      }, 'no-store');
    }
  }

  return {
    name: 'ocearch',
    configureServer({ middlewares }) {
      middlewares.use('/api/ocearch', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/ocearch', handler);
    },
  };
}

export const _ocearchInternals = {
  parseQuery,
  isSharkSpecies,
  selectTopSharks,
  findAnimal,
  parseMotion,
  ageDays,
  buildAnimalRow,
  buildPayload,
  motionUrl,
  ROSTER_URL,
  clearCaches: () => { payloadCache.clear(); inflight.clear(); docFailedAt = -Infinity; },
};
