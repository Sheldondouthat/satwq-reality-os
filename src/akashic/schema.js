/**
 * Akashic Records — canonical event schema.
 *
 * One record describes one discrete planetary event (earthquake, eruption
 * alert, meteor-shower peak, ...). Everything downstream (store, timeline,
 * replay, globe markers, export) speaks this shape and nothing else.
 *
 * Pure module: no DOM, no Cesium, no network. Safe to import in tests.
 */

export const AKASHIC_SCHEMA_VERSION = 1;
export const AKASHIC_MAX_EVENTS = 10000;

/** Event types the bundled adapters can produce. */
export const AKASHIC_EVENT_TYPES = Object.freeze([
  'earthquake',
  'volcano',
  'meteor',
  'launch',
  'fire',
  'custom',
]);

/**
 * Normalize a raw candidate into a canonical Akashic event.
 * Returns the normalized record, or null when the candidate is unusable.
 * Missing/unknown optional fields become null — never NaN/undefined.
 *
 * @param {object} raw
 * @param {string} raw.id Stable, source-scoped unique id (required).
 * @param {number} raw.time Unix epoch milliseconds (required, finite).
 * @param {string} raw.type One of AKASHIC_EVENT_TYPES (required).
 * @param {string} raw.layer Owning layer id, e.g. 'earthquakes' (required).
 * @param {string} raw.title Human label (required, non-empty).
 * @param {number} raw.lat Degrees, -90..90 (required).
 * @param {number} raw.lon Degrees, -180..180 (required).
 * @param {number} [raw.magnitude] Raw domain magnitude (quake M, ZHR, ...).
 * @param {number} [raw.severity] Normalized 0..1 display weight.
 * @param {string} [raw.source] Provenance label, e.g. 'USGS'.
 * @param {string} [raw.url] Deep link to the source record.
 * @param {string} [raw.detail] One-line extra context.
 */
export function normalizeAkashicEvent(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const id = String(raw.id ?? '').trim();
  const time = Number(raw.time);
  const type = String(raw.type ?? '')
    .trim()
    .toLowerCase();
  const layer = String(raw.layer ?? '').trim();
  const title = String(raw.title ?? '').trim();
  const lat = Number(raw.lat);
  const lon = Number(raw.lon);
  if (!id) return null;
  if (!Number.isFinite(time) || time <= 0) return null;
  if (!AKASHIC_EVENT_TYPES.includes(type)) return null;
  if (!layer) return null;
  if (!title) return null;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90) return null;
  if (!Number.isFinite(lon) || Math.abs(lon) > 180) return null;

  const magnitude = raw.magnitude == null ? null : Number(raw.magnitude);
  let severity = raw.severity == null ? null : Number(raw.severity);
  if (severity != null) {
    if (!Number.isFinite(severity)) severity = null;
    else severity = Math.min(1, Math.max(0, severity));
  }
  return {
    v: AKASHIC_SCHEMA_VERSION,
    id,
    time: Math.floor(time),
    type,
    layer,
    title,
    lat,
    lon,
    magnitude:
      magnitude != null && Number.isFinite(magnitude) ? magnitude : null,
    severity,
    source: typeof raw.source === 'string' && raw.source ? raw.source : null,
    url: typeof raw.url === 'string' && raw.url ? raw.url : null,
    detail: typeof raw.detail === 'string' && raw.detail ? raw.detail : null,
    recordedAt: Date.now(),
  };
}

/** Predicate: is this already a valid canonical record? */
export function isAkashicEvent(value) {
  return (
    normalizeAkashicEvent(value) !== null && value?.v === AKASHIC_SCHEMA_VERSION
  );
}

/** Sort helper: newest first, stable by id. */
export function compareEventsNewestFirst(a, b) {
  return b.time - a.time || String(a.id).localeCompare(String(b.id));
}

/** Sort helper: oldest first, stable by id. */
export function compareEventsOldestFirst(a, b) {
  return a.time - b.time || String(a.id).localeCompare(String(b.id));
}
