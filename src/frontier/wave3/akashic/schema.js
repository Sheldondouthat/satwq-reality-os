/**
 * Akashic Records — event archive schema (wave3, part C).
 *
 * Event-sourced planetary memory: every significant event is archived as a
 * small, self-contained record keyed by UTC day. This module owns the EVENT
 * ARCHIVE + timeline UX. It does NOT own watch-queries or the cinematic
 * replay (worker W3, item 1.11) — see INTEGRATION.md for the seam.
 *
 * Record shape (all fields JSON-serializable, localStorage-safe):
 *   {
 *     id:        'akashic:quake:us7000abcd',   // stable dedupe id
 *     day:       '2026-09-27',                 // UTC day key
 *     kind:      'quake' | 'alert' | 'incident' | 'fireball' | 'launch' | 'storm',
 *     atMs:      1758931200000,                // event time, epoch ms
 *     capturedMs: 1758931300000,               // archive time, epoch ms
 *     title:     'M6.2 earthquake — 42km ENE of …',
 *     detail:    '…',                          // <= 280 chars, plain text
 *     lat: 12.3, lon: -45.6,                   // nullable for global events
 *     severity:  'critical' | 'high' | 'moderate',
 *     sources:   ['usgs'],                     // provenance labels
 *     snapshot:  { … }                         // small per-kind data snapshot
 *   }
 */

/** Archive-worthy thresholds. */
export const SIGNIFICANCE = Object.freeze({
  QUAKE_MAG_MIN: 5.5,
  FIREBALL_ENERGY_KT_MIN: 0.1, // radiated energy floor; 0 = accept any dated fireball
  STORM_WIND_KT_MIN: 64, // hurricane-force named storms
  INCIDENT_SEVERITIES: Object.freeze(['high']), // synthesized incident severities worth archiving
});

/** NWS alert event names considered archive-worthy (warnings, not watches). */
export const ARCHIVE_ALERT_EVENTS = Object.freeze([
  'Tornado Warning',
  'Severe Thunderstorm Warning',
  'Flash Flood Warning',
  'Extreme Wind Warning',
  'Hurricane Warning',
  'Typhoon Warning',
  'Tsunami Warning',
  'Volcano Warning',
  'Dust Storm Warning',
  'Blizzard Warning',
  'Ice Storm Warning',
  'Flood Warning',
]);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Epoch ms → 'YYYY-MM-DD' UTC day key. Returns null for invalid input. */
export function dayKey(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → epoch ms of day start UTC, or null. */
export function dayStartMs(day) {
  if (typeof day !== 'string' || !DAY_RE.test(day)) return null;
  const ms = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Shift a day key by n days. */
export function shiftDay(day, n) {
  const start = dayStartMs(day);
  if (start === null || !Number.isInteger(n)) return null;
  return dayKey(start + n * 86_400_000);
}

/** Is the value a finite number (or null when the field is optional)? */
function finiteOrNull(v) {
  return v === null || v === undefined || Number.isFinite(v);
}

/**
 * Validate an archive record. Returns null when valid, otherwise a short
 * reason string. Pure — safe to run in node tests and in the browser.
 */
export function validateRecord(rec) {
  if (!rec || typeof rec !== 'object') return 'not-an-object';
  if (typeof rec.id !== 'string' || rec.id.length === 0 || rec.id.length > 160)
    return 'bad-id';
  if (typeof rec.day !== 'string' || !DAY_RE.test(rec.day)) return 'bad-day';
  const kinds = ['quake', 'alert', 'incident', 'fireball', 'launch', 'storm'];
  if (!kinds.includes(rec.kind)) return 'bad-kind';
  if (!Number.isFinite(rec.atMs) || !Number.isFinite(rec.capturedMs))
    return 'bad-time';
  if (
    typeof rec.title !== 'string' ||
    rec.title.length === 0 ||
    rec.title.length > 200
  )
    return 'bad-title';
  if (typeof rec.detail !== 'string' || rec.detail.length > 280)
    return 'bad-detail';
  if (!finiteOrNull(rec.lat) || !finiteOrNull(rec.lon)) return 'bad-coords';
  if (!['critical', 'high', 'moderate'].includes(rec.severity))
    return 'bad-severity';
  if (
    !Array.isArray(rec.sources) ||
    rec.sources.some((s) => typeof s !== 'string')
  )
    return 'bad-sources';
  if (
    rec.snapshot !== undefined &&
    (typeof rec.snapshot !== 'object' || rec.snapshot === null)
  )
    return 'bad-snapshot';
  return null;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Human one-liner for a day's worth of records: "Sep 27 — 4 events". */
export function daySummary(day, count) {
  const start = dayStartMs(day);
  const label =
    start === null
      ? day
      : `${MONTHS[new Date(start).getUTCMonth()]} ${new Date(start).getUTCDate()}`;
  return `${label} — ${count} event${count === 1 ? '' : 's'}`;
}
