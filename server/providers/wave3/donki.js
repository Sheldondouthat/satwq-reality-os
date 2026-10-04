/**
 * Wave 3 / Track 2a.5 — NASA DONKI space-weather events via the CCMC
 * keyless path (NOT api.nasa.gov, which needs a key).
 *
 * WHY A PROXY: kauai.ccmc.gsfc.nasa.gov serves no CORS headers for
 * browser use; this provider validates the event type + date window and
 * serves one compact normalized document at /api/donki.
 *
 * Upstream: https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/{CME,FLR,GST,SEP}
 *           ?startDate=yyyy-MM-dd&endDate=yyyy-MM-dd
 * (DOC-VERIFIED; CME endpoint live-verified 2026-09-27: 135 events in a
 * 31-day window.) Keyless. Global fetch only; no node:* (Pages-safe).
 *
 * CME Earth-impact ETA uses a ballistic (constant-speed) model from the
 * most-accurate analysis speed — labeled `etaModel: 'ballistic'` in the
 * payload and in the client legend. Real ENLIL runs decelerate; this is
 * a cinematic estimate, not a forecast.
 */
import { readResponseJsonCapped } from '../common/http.js';

const UPSTREAM = 'https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get';
const USER_AGENT =
  'satwq-reality-os/1.0 (NASA DONKI public via CCMC; contact via repo)';

const TYPES = ['CME', 'FLR', 'GST', 'SEP'];
const CACHE_TTL_MS = 30 * 60_000; // DONKI updates a few times per day
const STALE_MS = 12 * 3600_000;
const RETRY_COOLDOWN_MS = 120_000;
const UPSTREAM_TIMEOUT_MS = 25_000;
const JSON_CAP = 4 * 1024 * 1024;
const MAX_EVENTS = 60;
const AU_KM = 149_597_870.7;

/** Validate the event type. */
export function parseType(raw) {
  const t = (raw ?? 'CME').trim().toUpperCase();
  if (!TYPES.includes(t))
    throw Object.assign(new Error('donki_bad_type'), { status: 400 });
  return t;
}

/** Validate the trailing-days window. */
export function parseDays(raw) {
  const days = raw == null || raw === '' ? 30 : Number(raw);
  if (!Number.isFinite(days) || days < 1 || days > 60) {
    throw Object.assign(new Error('donki_bad_days'), { status: 400 });
  }
  return Math.floor(days);
}

export function windowDates(days, now = Date.now()) {
  const end = new Date(now);
  const start = new Date(now - days * 86400_000);
  const fmt = (d) => d.toISOString().slice(0, 10);
  return { startDate: fmt(start), endDate: fmt(end) };
}

/** Null-safe number: null/undefined stay missing instead of becoming 0. */
function num(v) {
  return v == null ? Number.NaN : Number(v);
}

/**
 * Heuristic Earth-directedness for a CME analysis. MODEL — the client
 * legend must say so. A CME counts as Earth-directed when the source is
 * near disk center, the cone is wide (halo-ish), or the analyst note says
 * Earth-directed.
 */
export function isEarthDirected(analysis, note = '') {
  if (!analysis) return false;
  const lat = num(analysis.latitude);
  const lon = num(analysis.longitude);
  const halfAngle = num(analysis.halfAngle);
  const text = `${note} ${analysis.note ?? ''}`.toLowerCase();
  if (/earth-directed|earth directed|halo/.test(text)) return true;
  if (Number.isFinite(halfAngle) && halfAngle >= 90) return true;
  if (Number.isFinite(lat) && Number.isFinite(lon)) {
    return Math.abs(lat) <= 45 && Math.abs(lon) <= 60;
  }
  return false;
}

/** Ballistic Sun->Earth transit hours at constant speed. MODEL. */
export function ballisticTransitHours(speedKms) {
  if (!Number.isFinite(speedKms) || speedKms <= 0) return null;
  return AU_KM / speedKms / 3600;
}

function mostAccurate(analyses) {
  if (!Array.isArray(analyses) || analyses.length === 0) return null;
  return analyses.find((a) => a?.isMostAccurate) ?? analyses[0];
}

/** Normalize one CME record. */
export function parseCme(rec) {
  const analysis = mostAccurate(rec?.cmeAnalyses);
  const speed = num(analysis?.speed);
  const transitHours = ballisticTransitHours(speed);
  const startMs = Date.parse(rec?.startTime);
  const halfAngle = num(analysis?.halfAngle);
  const sourceLat = num(analysis?.latitude);
  const sourceLon = num(analysis?.longitude);
  return {
    id: rec?.activityID ?? null,
    startMs: Number.isFinite(startMs) ? startMs : null,
    sourceLocation: rec?.sourceLocation ?? '',
    activeRegion: rec?.activeRegionNum ?? null,
    speedKms: Number.isFinite(speed) ? speed : null,
    halfAngleDeg: Number.isFinite(halfAngle) ? halfAngle : null,
    sourceLat: Number.isFinite(sourceLat) ? sourceLat : null,
    sourceLon: Number.isFinite(sourceLon) ? sourceLon : null,
    earthDirected: isEarthDirected(analysis, rec?.note),
    etaHours: transitHours,
    etaMs:
      Number.isFinite(startMs) && transitHours != null
        ? startMs + transitHours * 3600_000
        : null,
    note: String(rec?.note ?? '').slice(0, 300),
    link: rec?.link ?? null,
  };
}

/** Normalize one solar-flare record. */
export function parseFlr(rec) {
  const peakMs = Date.parse(rec?.peakTime);
  return {
    id: rec?.flrID ?? null,
    class: rec?.classType ?? null,
    peakMs: Number.isFinite(peakMs) ? peakMs : null,
    sourceLocation: rec?.sourceLocation ?? '',
    activeRegion: rec?.activeRegionNum ?? null,
    link: rec?.link ?? null,
  };
}

/** Normalize one geomagnetic-storm record. */
export function parseGst(rec) {
  const kps = Array.isArray(rec?.allKpIndex)
    ? rec.allKpIndex.map((k) => Number(k?.kpIndex)).filter(Number.isFinite)
    : [];
  const startMs = Date.parse(rec?.startTime);
  return {
    id: rec?.gstID ?? null,
    startMs: Number.isFinite(startMs) ? startMs : null,
    maxKp: kps.length ? Math.max(...kps) : null,
    link: rec?.link ?? null,
  };
}

/** Normalize one SEP record. */
export function parseSep(rec) {
  const onsetMs = Date.parse(rec?.eventTime);
  return {
    id: rec?.sepID ?? null,
    onsetMs: Number.isFinite(onsetMs) ? onsetMs : null,
    instruments: Array.isArray(rec?.instruments)
      ? rec.instruments.map((i) => i?.displayName ?? '').filter(Boolean)
      : [],
    link: rec?.link ?? null,
  };
}

const PARSERS = { CME: parseCme, FLR: parseFlr, GST: parseGst, SEP: parseSep };

/** Normalize a raw DONKI array for the requested type. */
export function parseDonkiPayload(doc, type, { maxEvents = MAX_EVENTS } = {}) {
  if (!Array.isArray(doc)) throw new Error('donki_unexpected_shape');
  const parse = PARSERS[type];
  return doc
    .slice(0, maxEvents)
    .map(parse)
    .filter((e) => e && e.id);
}

function describe(value, { stale = false, reason = null } = {}) {
  return {
    schemaVersion: 1,
    source: 'NASA DONKI via CCMC keyless path, local proxy',
    attribution: 'Solar event data: NASA CCMC DONKI (public domain).',
    etaModel:
      'CME ETA is a ballistic constant-speed model — a cinematic estimate, not a forecast.',
    fetchedAt: value?.fetchedAt ?? null,
    stale,
    unavailable: !value,
    reason,
    type: value?.type ?? null,
    days: value?.days ?? null,
    events: value?.events ?? [],
  };
}

export function donkiProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  const cache = new Map();
  const inflight = new Map();
  const attemptedAt = new Map();

  async function fetchUpstream(type, days, signal) {
    const { startDate, endDate } = windowDates(days, now());
    const url = `${UPSTREAM}/${type}?startDate=${startDate}&endDate=${endDate}`;
    signal.throwIfAborted();
    const response = await fetchImpl(url, {
      signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(`donki_upstream_http_${response.status}`);
    }
    const doc = await readResponseJsonCapped(response, JSON_CAP, signal);
    signal.throwIfAborted();
    return {
      type,
      days,
      events: parseDonkiPayload(doc, type),
      fetchedAt: now(),
    };
  }

  async function acquire(type, days, signal) {
    const key = `${type}|${days}`;
    const hit = cache.get(key);
    if (hit && now() - hit.fetchedAt < CACHE_TTL_MS)
      return { value: hit.value, stale: false };
    signal.throwIfAborted();
    let op = inflight.get(key);
    if (!op) {
      if (now() - (attemptedAt.get(key) ?? -Infinity) < RETRY_COOLDOWN_MS) {
        throw new Error('donki_retry_later');
      }
      attemptedAt.set(key, now());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs + 5000);
      op = fetchUpstream(type, days, controller.signal)
        .then((value) => {
          if (cache.size >= 8) cache.delete(cache.keys().next().value);
          cache.set(key, { value, fetchedAt: now() });
          return { value, stale: false };
        })
        .finally(() => {
          clearTimeout(timer);
          inflight.delete(key);
        });
      inflight.set(key, op);
    }
    const cancelled = new Promise((_, reject) => {
      const abort = () => reject(signal.reason ?? new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      const detach = () => signal.removeEventListener('abort', abort);
      op.then(detach, detach); // both branches resolve: never an unhandled rejection
    });
    return Promise.race([op, cancelled]);
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    const json = (status, value) => {
      if (controller.signal.aborted) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      const query = new URL(req.url, 'http://localhost').searchParams;
      let type;
      let days;
      try {
        type = parseType(query.get('type'));
        days = parseDays(query.get('days'));
      } catch (error) {
        return json(error.status ?? 400, { error: error.message });
      }
      try {
        const { value, stale } = await acquire(type, days, controller.signal);
        json(200, describe(value, { stale }));
      } catch (error) {
        const key = `${type}|${days}`;
        const hit = cache.get(key);
        const usable = hit && now() - hit.fetchedAt <= STALE_MS;
        json(
          200,
          usable
            ? describe(hit.value, {
                stale: true,
                reason: 'DONKI unreachable; showing last sweep.',
              })
            : describe(null, {
                reason: 'NASA DONKI unreachable and no cached sweep exists.',
              }),
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'donki',
    configureServer({ middlewares }) {
      middlewares.use('/api/donki', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/donki', handler);
    },
  };
}
