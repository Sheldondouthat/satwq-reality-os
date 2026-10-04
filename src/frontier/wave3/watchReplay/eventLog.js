/**
 * Akashic event log (Wave 3, Track 1c, item 1.11) — persistent, day-keyed.
 *
 * The repo's Akashic Records keep a rich IndexedDB store, but the replay
 * feature needs one simple contract: "give me everything that happened on
 * day D". This module defines that contract as a localStorage log keyed by
 * day — the fallback the Wave 3 brief explicitly requests when no
 * persistent event log exists.
 *
 * Schema (v1):
 *   key:   satwq.eventlog.YYYY-MM-DD   (UTC day)
 *   value: { v: 1, day: 'YYYY-MM-DD', events: [event], updatedAt: ms }
 *   event: { t: ms, type: 'quake'|'alert'|'fire'|'storm'|..., lat, lon,
 *            label, mag?, depthKm?, source }
 *
 * Capped at 5000 events/day; duplicates (same t+type+label) are dropped.
 */

export const LOG_KEY_PREFIX = 'satwq.eventlog.';
export const MAX_EVENTS_PER_DAY = 5000;
export const SCHEMA_VERSION = 1;

export function dayKey(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return `${LOG_KEY_PREFIX}${d.toISOString().slice(0, 10)}`;
}

export function listDayKeys(storage) {
  const keys = [];
  for (const k of storage.keys()) {
    if (k.startsWith(LOG_KEY_PREFIX)) keys.push(k);
  }
  return keys.sort();
}

function readDoc(storage, key) {
  try {
    const raw = storage.get(key);
    if (!raw) return null;
    const doc = JSON.parse(raw);
    if (!doc || doc.v !== SCHEMA_VERSION || !Array.isArray(doc.events))
      return null;
    return doc;
  } catch {
    return null;
  }
}

/** Append events to a day's log. Returns the new event count. */
export function appendEvents(storage, dayOrDate, events) {
  const key =
    typeof dayOrDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dayOrDate)
      ? LOG_KEY_PREFIX + dayOrDate
      : dayKey(dayOrDate);
  const doc = readDoc(storage, key) ?? {
    v: SCHEMA_VERSION,
    day: key.slice(LOG_KEY_PREFIX.length),
    events: [],
    updatedAt: 0,
  };
  const seen = new Set(doc.events.map((e) => `${e.t}|${e.type}|${e.label}`));
  for (const e of events ?? []) {
    const norm = normalizeEvent(e);
    if (!norm) continue;
    const sig = `${norm.t}|${norm.type}|${norm.label}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    doc.events.push(norm);
  }
  doc.events.sort((a, b) => a.t - b.t);
  if (doc.events.length > MAX_EVENTS_PER_DAY) {
    doc.events = doc.events.slice(doc.events.length - MAX_EVENTS_PER_DAY);
  }
  doc.updatedAt = Date.now();
  storage.set(key, JSON.stringify(doc));
  return doc.events.length;
}

function normalizeEvent(e) {
  if (!e || typeof e !== 'object') return null;
  const t = Number(e.t ?? e.timeMs);
  const lat = Number(e.lat);
  const lon = Number(e.lon);
  if (!Number.isFinite(t) || !Number.isFinite(lat) || !Number.isFinite(lon))
    return null;
  return {
    t,
    type: String(e.type ?? 'event'),
    lat,
    lon,
    label: String(e.label ?? e.place ?? 'event'),
    ...(Number.isFinite(Number(e.mag)) ? { mag: Number(e.mag) } : {}),
    ...(Number.isFinite(Number(e.depthKm))
      ? { depthKm: Number(e.depthKm) }
      : {}),
    source: String(e.source ?? 'satwq'),
  };
}

/** Read one day's events, chronological. */
export function readDay(storage, day) {
  const doc = readDoc(storage, LOG_KEY_PREFIX + day);
  return doc ? doc.events : [];
}

/** Drop day logs older than keepDays (keeps at least the newest day). */
export function pruneDays(storage, keepDays = 30) {
  const keys = listDayKeys(storage);
  const cutoff = Date.now() - keepDays * 24 * 3600_000;
  let dropped = 0;
  for (const key of keys) {
    const day = key.slice(LOG_KEY_PREFIX.length);
    const dayMs = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(dayMs) && dayMs < cutoff) {
      storage.remove(key);
      dropped++;
    }
  }
  return dropped;
}

/**
 * Map USGS-style earthquake rows to log events.
 * Accepts rows shaped like {usgsId|stableId|id, lat, lon, mag, place, time|timeMs}.
 */
export function quakeRowsToEvents(rows) {
  const out = [];
  for (const r of rows ?? []) {
    if (r?.mag == null || !Number.isFinite(Number(r.mag))) continue; // Number(null) === 0: no mag, no event
    const e = normalizeEvent({
      t: r.timeMs ?? r.time,
      type: 'quake',
      lat: r.lat,
      lon: r.lon,
      label: `M${r.mag} ${r.place ?? ''}`.trim(),
      mag: r.mag,
      depthKm: r.depthKm,
      source: 'usgs',
    });
    if (e) out.push(e);
  }
  return out;
}
