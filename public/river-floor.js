/* God's Eye — river floor logic (V5-0): the Glen Lyn record-cache,
 * as pure functions. No DOM, no fetch, no clock reads — every function
 * takes its time explicitly so the module is testable end to end.
 *
 * The constitution this implements (Packaging Matrix row 3, §2):
 *  1. Records are cached as records, never as renderings. The page
 *     stores the record below — source id, the DATA's own timestamp,
 *     values, provenance — in a versioned floor-package cache
 *     (localStorage; the service worker never touches /api/* and
 *     never holds records).
 *  2. Age is rendered from the record's own timestamp (dataTime),
 *     NEVER from fetch time and never from the payload's generatedAt.
 *     A fresh generatedAt wrapped around an old reading (the
 *     2026-11-15 D-1 ghost) still ages by its dataTime.
 *  3. STALE is a schedule: past MAX_AGE_SECONDS the classification is
 *     'stale' on every render path, and the watcher-blind flag is set.
 *  4. A record served from the cache can NEVER classify as 'live' —
 *     'held' is the strongest grammar the cache path can produce.
 *     'live' additionally requires a live link: a fetch that succeeded
 *     this session with no failed attempt since.
 */

export const FLOOR_PACKAGE = Object.freeze({
  id: 'gev-floor-river-glen-lyn',
  version: 1,
});

export const RECORD_CACHE_KEY =
  'gev.floor-record.v1:usgs-water-glen-lyn-03176500';

export const SOURCE_ID = 'usgs-water-glen-lyn';
export const SITE = '03176500';

/** Registry record v2 (glen-lyn-03176500): freshness.max_age_seconds. */
export const MAX_AGE_SECONDS = 3600;
/** Local caution rule (river_bot) — NOT an official stage. */
export const CAUTION_FT = 13;
/** NWS flood stage for this gauge. */
export const FLOOD_STAGE_FT = 15;

function finiteOrNull(value) {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

function parseTimeMs(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Build a floor record from a /api/usgs-water-glen-lyn payload.
 * Returns null when the payload cannot honestly become a record
 * (no parseable data timestamp, or neither variable present).
 * fetchedAtMs is stored as provenance only — age NEVER derives from it.
 */
export function buildRecord(apiPayload, fetchedAtMs) {
  if (!apiPayload || typeof apiPayload !== 'object') return null;
  const dataTimeMs = parseTimeMs(apiPayload.dataTime);
  if (dataTimeMs == null) return null;
  const gageHeightFt = finiteOrNull(apiPayload.gageHeightFt);
  const dischargeCfs = finiteOrNull(apiPayload.dischargeCfs);
  if (gageHeightFt == null && dischargeCfs == null) return null;
  const thresholds = apiPayload.thresholds || {};
  return {
    floorPackage: { id: FLOOR_PACKAGE.id, version: FLOOR_PACKAGE.version },
    sourceId:
      typeof apiPayload.id === 'string' ? apiPayload.id : SOURCE_ID,
    site:
      typeof apiPayload.site === 'string' ? apiPayload.site : SITE,
    name:
      typeof apiPayload.name === 'string'
        ? apiPayload.name
        : 'NEW RIVER AT GLEN LYN, VA',
    dataTime: new Date(dataTimeMs).toISOString(),
    gageHeightFt,
    dischargeCfs,
    approvalStatus:
      typeof apiPayload.approvalStatus === 'string'
        ? apiPayload.approvalStatus
        : null,
    thresholds: {
      cautionFt: finiteOrNull(thresholds.cautionFt) ?? CAUTION_FT,
      floodStageFt: finiteOrNull(thresholds.floodStageFt) ?? FLOOD_STAGE_FT,
    },
    maxAgeSeconds:
      finiteOrNull(apiPayload.maxAgeSeconds) ?? MAX_AGE_SECONDS,
    fetchedAt: new Date(fetchedAtMs).toISOString(),
  };
}

/**
 * Validate a record read back from the floor cache. A record from a
 * different floor-package version is not rendered — the cache is
 * invalidated honestly rather than rendered in a foreign shape.
 */
export function validateRecord(record) {
  if (!record || typeof record !== 'object') return null;
  if (
    record.floorPackage?.id !== FLOOR_PACKAGE.id ||
    record.floorPackage?.version !== FLOOR_PACKAGE.version
  )
    return null;
  if (parseTimeMs(record.dataTime) == null) return null;
  if (
    finiteOrNull(record.gageHeightFt) == null &&
    finiteOrNull(record.dischargeCfs) == null
  )
    return null;
  return record;
}

/** Age of the reading at nowMs, from the DATA's own timestamp. */
export function ageSecondsAt(record, nowMs) {
  const dataMs = parseTimeMs(record?.dataTime);
  if (dataMs == null) return null;
  return Math.max(0, Math.floor((nowMs - dataMs) / 1000));
}

/** Threshold state from a gage height (ft). No height → 'unknown'. */
export function thresholdState(gageHeightFt, thresholds = {}) {
  const h = finiteOrNull(gageHeightFt);
  if (h == null) return 'unknown';
  const flood = finiteOrNull(thresholds.floodStageFt) ?? FLOOD_STAGE_FT;
  const caution = finiteOrNull(thresholds.cautionFt) ?? CAUTION_FT;
  if (h >= flood) return 'flood';
  if (h >= caution) return 'caution';
  return 'ok';
}

/**
 * The one classification every render goes through.
 *   fromCache — the record came from the floor cache (not a fetch
 *               that just succeeded on a live link).
 * Returns { ageSeconds, freshness: 'live'|'held'|'stale',
 *           threshold, blind }.
 * 'live' is unreachable when fromCache is true, and unreachable for
 * any record past max-age, whatever its source — the two ways a value
 * could wear live grammar over old data are both closed here.
 */
export function classifyRecord(record, nowMs, { fromCache = false } = {}) {
  const ageSeconds = ageSecondsAt(record, nowMs);
  const maxAge = finiteOrNull(record?.maxAgeSeconds) ?? MAX_AGE_SECONDS;
  const stale = ageSeconds == null || ageSeconds > maxAge;
  return {
    ageSeconds,
    freshness: stale ? 'stale' : fromCache ? 'held' : 'live',
    threshold: thresholdState(record?.gageHeightFt, record?.thresholds),
    blind: stale,
  };
}

/** Human age: 45 → "45 s", 750 → "12 min", 79200 → "22 h 00 min". */
export function formatAge(totalSeconds) {
  if (totalSeconds == null || !Number.isFinite(totalSeconds)) return 'unknown age';
  const s = Math.max(0, Math.floor(totalSeconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const hm = `${hours} h ${String(mins).padStart(2, '0')} min`;
  return days > 0 ? `${days} d ${hm}` : hm;
}
