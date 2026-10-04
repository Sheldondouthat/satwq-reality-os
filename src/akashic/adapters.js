/**
 * Akashic Records — layer adapters.
 *
 * Pure mappers from each layer's normalized row shape to raw Akashic event
 * candidates (see schema.js). No fetching here: the recorder hands each
 * adapter the rows its poller already fetched. No DOM, no Cesium.
 */
import { normalizeAkashicEvent } from './schema.js';

const USGS_QUAKE_URL = 'https://earthquake.usgs.gov/earthquakes/eventpage/';
const USGS_VOLCANO_URL = 'https://www.usgs.gov/volcanoes/';

/**
 * Map USGS earthquake rows ({stableId, usgsId, lon, lat, depthKm, mag, place, time})
 * to Akashic events. Severity scales M2.5..M9 -> 0..1.
 */
export function earthquakeRowsToEvents(rows) {
  if (!Array.isArray(rows)) return [];
  const events = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const event = normalizeAkashicEvent({
      id: `quake:${row.usgsId ?? row.stableId}`,
      time: row.time,
      type: 'earthquake',
      layer: 'earthquakes',
      title:
        row.mag != null
          ? `M${Number(row.mag).toFixed(1)} — ${row.place ?? 'unknown location'}`
          : `Earthquake — ${row.place ?? 'unknown location'}`,
      lat: row.lat,
      lon: row.lon,
      magnitude: row.mag,
      severity:
        row.mag == null
          ? 0.25
          : Math.min(1, Math.max(0, (row.mag - 2.5) / 6.5)),
      source: 'USGS',
      url: row.usgsId ? `${USGS_QUAKE_URL}${row.usgsId}` : null,
      detail:
        row.depthKm != null
          ? `${Number(row.depthKm).toFixed(1)} km deep`
          : null,
    });
    if (event) events.push(event);
  }
  return events;
}

/**
 * Map USGS volcano rows ({stableId, name, lon, lat, alertLevel, colorCode})
 * to Akashic events. Only elevated color codes (YELLOW/ORANGE/RED) become
 * events — quiet volcanoes are not "planetary events".
 */
export function volcanoRowsToEvents(rows, { now = () => Date.now() } = {}) {
  if (!Array.isArray(rows)) return [];
  const elevated = new Set(['YELLOW', 'ORANGE', 'RED']);
  const weight = { YELLOW: 0.4, ORANGE: 0.7, RED: 1 };
  const events = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const code = String(row.colorCode ?? '').toUpperCase();
    if (!elevated.has(code)) continue;
    const event = normalizeAkashicEvent({
      id: `volcano:${row.stableId}:${code}`,
      time: now(),
      type: 'volcano',
      layer: 'volcanoes',
      title: `${row.name ?? 'Unnamed volcano'} — ${code} alert`,
      lat: row.lat,
      lon: row.lon,
      severity: weight[code] ?? 0.4,
      source: 'USGS Volcano Hazards Program',
      url: USGS_VOLCANO_URL,
      detail: row.alertLevel ? `Alert level: ${row.alertLevel}` : null,
    });
    if (event) events.push(event);
  }
  return events;
}

/**
 * Greenwich Mean Sidereal Time in degrees for a UTC epoch.
 * Used to place a meteor shower's radiant subpoint on the globe.
 */
export function gmstDegrees(epochMs) {
  const d = epochMs / 86400000 - 10957.5; // days since J2000.0
  const gmst = 280.46061837 + 360.98564736629 * d;
  return ((gmst % 360) + 360) % 360;
}

/** RA (hours) + Dec (deg) -> geographic subpoint at the given UTC epoch. */
export function radiantSubpoint(raHours, decDeg, epochMs) {
  const lon = ((gmstDegrees(epochMs) - raHours * 15 + 540) % 360) - 180;
  return { lat: Math.max(-90, Math.min(90, decDeg)), lon };
}

/**
 * Map meteor-source rows ({stableId, shower:{name, peakMonth, peakDay, ra, dec, zhr}})
 * to Akashic "shower peak" events, one per shower per year, anchored at the
 * radiant subpoint at peak UTC noon.
 */
export function meteorRowsToEvents(rows, { now = () => Date.now() } = {}) {
  if (!Array.isArray(rows)) return [];
  const current = new Date(now());
  const events = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const shower =
      row.shower && typeof row.shower === 'object' ? row.shower : row;
    const { name, peakMonth, peakDay, ra, dec, zhr } = shower;
    if (!name || !Number.isFinite(peakMonth) || !Number.isFinite(peakDay))
      continue;
    const peak = Date.UTC(current.getUTCFullYear(), peakMonth - 1, peakDay, 12);
    const sub =
      Number.isFinite(ra) && Number.isFinite(dec)
        ? radiantSubpoint(ra, dec, peak)
        : { lat: 0, lon: 0 };
    const event = normalizeAkashicEvent({
      id: `meteor:${String(name)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')}:${current.getUTCFullYear()}`,
      time: peak,
      type: 'meteor',
      layer: 'meteors',
      title: `${name} meteor shower peak`,
      lat: sub.lat,
      lon: sub.lon,
      magnitude: zhr,
      severity:
        zhr == null ? 0.3 : Math.min(1, Math.max(0.1, Number(zhr) / 150)),
      source: 'IMO shower table (bundled)',
      url: 'https://www.imo.net/',
      detail:
        zhr != null ? `ZHR ~${zhr} at radiant subpoint` : 'Radiant subpoint',
    });
    if (event) events.push(event);
  }
  return events;
}
