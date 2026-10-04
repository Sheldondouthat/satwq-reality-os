/**
 * CNEOS fireball (bolide) impact proxy — Track 3a item 3.2.
 *
 * Upstream: https://ssd-api.jpl.nasa.gov/fireball.api (DOC-VERIFIED keyless,
 * verified live 2026-09-27). Every US-government-sensor fireball since 1988:
 * date, radiated energy (kilotons TNT), impact energy, lat/lon, altitude,
 * velocity. Response shape: {signature, count, fields, data} where each data
 * row is [date, energy, impact-e, lat, lat-dir, lon, lon-dir, alt, vel].
 *
 * Routes:
 *   GET /api/fireballs            → normalized archive JSON
 *   GET /api/fireballs?days=30    → adds `recent` flags (default 30)
 *   GET /api/fireballs?minKt=1    → filter to energyKt >= minKt
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped reads,
 * no node: imports, no WASM, no `redirect:'error'` — workerd rejects it).
 *
 * Physics-honesty: energies are derived from optical/infrasound sensor data
 * with roughly factor-of-two uncertainty; the payload says so.
 */

import { readResponseJsonCapped } from '../common/http.js';

const UPSTREAM_URL = 'https://ssd-api.jpl.nasa.gov/fireball.api?req-loc=true';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 6 * 3600_000; // archive changes rarely; 6h is plenty
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless CNEOS fireball context; contact: public repo)';
const HONESTY =
  'US government sensor detections via NASA CNEOS. Energies derived from ' +
  'optical/infrasound measurements, roughly factor-of-two uncertainty. ' +
  'alt/vel are null where the sensors did not report them.';

/** Parse "YYYY-MM-DD HH:MM:SS" as UTC; null on garbage. */
export function parseFireballDate(raw) {
  if (typeof raw !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(
    raw.trim(),
  );
  if (!m) return null;
  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Normalize one CNEOS data row into a fireball event. Null on bad row. */
export function normalizeFireballRow(row, fields) {
  if (!Array.isArray(row)) return null;
  const byName = {};
  for (let i = 0; i < fields.length && i < row.length; i++)
    byName[fields[i]] = row[i];
  const dateUtc = parseFireballDate(byName.date);
  // CNEOS API doc v1.2 (verified 2026-09-27): `energy` is total RADIATED
  // energy in 10^10 joules — NOT kilotons. `impact-e` is the kiloton field.
  // (Chelyabinsk: energy=37500, impact-e=441.) energyKt MUST come from impact-e.
  const radiatedE10J = numOrNull(byName.energy);
  const energyKt = numOrNull(byName['impact-e']);
  let lat = numOrNull(byName.lat);
  let lon = numOrNull(byName.lon);
  if (lat === null || lon === null || dateUtc === null || energyKt === null)
    return null;
  if (String(byName['lat-dir']).toUpperCase() === 'S') lat = -Math.abs(lat);
  if (String(byName['lon-dir']).toUpperCase() === 'W') lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    id: `cneos-${dateUtc}`,
    dateUtc,
    energyKt, // kilotons of TNT, from impact-e
    impactEnergyKt: energyKt, // alias kept for contract stability
    radiatedE10J, // 10^10 J, from energy — radiated, not impact
    lat,
    lon,
    altKm: numOrNull(byName.alt),
    velKms: numOrNull(byName.vel),
  };
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    // NOTE: no `redirect: 'error'` — workerd rejects that value; the default
    // 'follow' is what we want for a GET anyway.
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!res.ok)
      throw Object.assign(new Error(`fireball_upstream_${res.status}`), {
        status: 502,
      });
    // readResponseJsonCapped returns the PARSED JSON (throws
    // {code:'RESPONSE_TOO_LARGE'} when the cap is crossed) — no tuple.
    return await readResponseJsonCapped(res, BODY_CAP_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

/** Mount the CNEOS fireball proxy. Mirrors the vaac/hmsSmoke provider shape. */
export function fireballsProxy() {
  let cache = null; // { at, events }
  let inflight = null;

  async function getEvents() {
    const nowMs = Date.now();
    if (cache && nowMs - cache.at < CACHE_TTL_MS) return cache.events;
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const payload = await fetchJson(UPSTREAM_URL);
        const fields = Array.isArray(payload?.fields)
          ? payload.fields.map(String)
          : [];
        const rows = Array.isArray(payload?.data) ? payload.data : [];
        if (!fields.length || !rows.length)
          throw new Error('fireball_upstream_empty');
        const events = [];
        for (const row of rows) {
          const ev = normalizeFireballRow(row, fields);
          if (ev) events.push(ev);
        }
        if (!events.length) throw new Error('fireball_upstream_unparseable');
        events.sort((a, b) => (a.dateUtc < b.dateUtc ? 1 : -1));
        cache = { at: Date.now(), events };
        return events;
      } catch (error) {
        if (cache) return cache.events; // stale beats empty
        throw error;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  function sendJson(res, status, body) {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': status === 200 ? 'public, max-age=21600' : 'no-store',
    });
    res.end(JSON.stringify(body));
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    let days = 30;
    let minKt = 0;
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const d = parsed.searchParams.get('days');
      const k = parsed.searchParams.get('minKt');
      if (d !== null)
        days = Math.min(3650, Math.max(1, Math.floor(Number(d) || 30)));
      if (k !== null) minKt = Math.max(0, Number(k) || 0);
    } catch {
      return sendJson(res, 400, { error: 'fireballs_bad_request' });
    }
    try {
      const all = await getEvents();
      const cutoff = Date.now() - days * 86400_000;
      const events = all
        .filter((e) => e.energyKt >= minKt)
        .map((e) => ({ ...e, recent: Date.parse(e.dateUtc) >= cutoff }));
      sendJson(res, 200, {
        events,
        count: events.length,
        archiveCount: all.length,
        fetchedAt: new Date(cache.at).toISOString(),
        upstream: 'https://ssd-api.jpl.nasa.gov/fireball.api',
        honesty: HONESTY,
      });
    } catch {
      sendJson(res, 502, { error: 'fireballs_upstream_unavailable' });
    }
  }

  return {
    name: 'fireballs',
    configureServer({ middlewares }) {
      middlewares.use('/api/fireballs', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/fireballs', handler);
    },
  };
}
