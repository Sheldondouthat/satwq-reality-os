/**
 * Akashic Records — event archiver.
 *
 * Polls the keyless feeds and converts significant events into archive
 * records. Sources (all keyless, browser-fetchable):
 *   - USGS M4.5+ day GeoJSON (direct) → kind 'quake', threshold M≥5.5
 *   - NWS api.weather.gov/alerts/active (direct) → kind 'alert'
 *   - GET /api/events (synthesized incidents) → kind 'incident', severity high
 *   - NASA CNEOS fireball API (direct) → kind 'fireball'
 *   - GET /api/launches (LL2 proxy) → kind 'launch'
 *   - GET /api/cyclones → kind 'storm' (hurricane-force named storms)
 *
 * Every record carries a small `snapshot` — the raw values worth replaying
 * later. The archiver never throws: each source is isolated and fail-soft.
 */
import { dayKey, SIGNIFICANCE, ARCHIVE_ALERT_EVENTS } from './schema.js';

const USGS_QUAKES_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active?limit=200';
const FIREBALL_URL =
  'https://ssd-api.jpl.nasa.gov/fireball.api?date-min=2025-01-01&sort=date&limit=40';

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function text(v, fallback = '') {
  return typeof v === 'string' && v.length ? v : fallback;
}

/** Build a quake record from a USGS GeoJSON feature. Null when not significant. */
export function quakeRecord(feature, capturedMs = Date.now()) {
  const coords = feature?.geometry?.coordinates;
  const props = feature?.properties ?? {};
  const lon = coords?.[0];
  const lat = coords?.[1];
  const mag = props?.mag;
  if (!Number.isFinite(mag) || mag < SIGNIFICANCE.QUAKE_MAG_MIN) return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const atMs = Number.isFinite(props?.time) ? props.time : capturedMs;
  const day = dayKey(atMs);
  if (!day) return null;
  const id = `akashic:quake:${text(feature?.id, `${lat.toFixed(2)},${lon.toFixed(2)}`)}`;
  return {
    id,
    day,
    kind: 'quake',
    atMs,
    capturedMs,
    title: `M${mag.toFixed(1)} earthquake — ${truncate(text(props?.place, 'unknown location'), 80)}`,
    detail: truncate(
      `Magnitude ${mag.toFixed(1)} at ${Number.isFinite(coords?.[2]) ? `${coords[2].toFixed(0)} km` : '?'} depth. Reported by USGS.`,
      280,
    ),
    lat,
    lon,
    severity: mag >= 7 ? 'critical' : mag >= 6 ? 'high' : 'moderate',
    sources: ['usgs'],
    snapshot: {
      mag,
      place: text(props?.place, ''),
      depthKm: Number.isFinite(coords?.[2]) ? coords[2] : null,
      tsunami: props?.tsunami === 1,
      url: text(props?.url, ''),
    },
  };
}

/** Build an alert record from an NWS alert feature. Null when not archive-worthy. */
export function nwsAlertRecord(feature, capturedMs = Date.now()) {
  const props = feature?.properties ?? {};
  const event = text(props?.event, '');
  if (!ARCHIVE_ALERT_EVENTS.includes(event)) return null;
  const id = `akashic:alert:${text(props?.id, '').split('/').pop() || `${event}-${props?.sent || capturedMs}`}`;
  const atMs = Date.parse(props?.sent) || Date.parse(props?.effective) || capturedMs;
  if (!Number.isFinite(atMs)) return null;
  const day = dayKey(atMs);
  if (!day) return null;
  const geo = feature?.geometry;
  let lat = null;
  let lon = null;
  if (geo?.type === 'Point' && Array.isArray(geo.coordinates)) {
    [lon, lat] = geo.coordinates;
  }
  return {
    id,
    day,
    kind: 'alert',
    atMs,
    capturedMs,
    title: truncate(`${event} — ${text(props?.areaDesc, 'area unspecified').split(';')[0]}`, 120),
    detail: truncate(text(props?.headline, event), 280),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    severity: /tornado|tsunami|extreme wind/i.test(event) ? 'critical' : 'high',
    sources: ['nws'],
    snapshot: {
      event,
      severity: text(props?.severity, ''),
      certainty: text(props?.certainty, ''),
      areaDesc: truncate(text(props?.areaDesc, ''), 200),
      instruction: truncate(text(props?.instruction, ''), 200),
    },
  };
}

/** Build an incident record from a /api/events synthesized incident. */
export function incidentRecord(incident, capturedMs = Date.now()) {
  if (!incident || typeof incident !== 'object') return null;
  if (!SIGNIFICANCE.INCIDENT_SEVERITIES.includes(incident.severity)) return null;
  const atMs = Date.parse(incident.at) || capturedMs;
  const day = dayKey(atMs);
  if (!day) return null;
  return {
    id: `akashic:incident:${truncate(text(incident.id, `${incident.type}-${atMs}`), 120)}`,
    day,
    kind: 'incident',
    atMs,
    capturedMs,
    title: truncate(text(incident.title, 'Synthesized incident'), 120),
    detail: truncate(text(incident.detail, ''), 280),
    lat: Number.isFinite(incident.lat) ? incident.lat : null,
    lon: Number.isFinite(incident.lon) ? incident.lon : null,
    severity: incident.severity === 'high' ? 'high' : 'moderate',
    sources: Array.isArray(incident.sources) ? incident.sources.map(String) : [],
    snapshot: {
      type: text(incident.type, ''),
      confidence: Number.isFinite(incident.confidence) ? incident.confidence : null,
    },
  };
}

/** Build a fireball record from a CNEOS fireball row object. Null when undated. */
export function fireballRecord(row, capturedMs = Date.now()) {
  const dateStr = text(row?.date, '');
  const atMs = Date.parse(dateStr.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(atMs)) return null;
  const energyKt = Number(row?.['impact-e']);
  if (Number.isFinite(energyKt) && energyKt < SIGNIFICANCE.FIREBALL_ENERGY_KT_MIN) return null;
  let lat = Number(row?.lat);
  if (String(row?.['lat-dir']).toUpperCase() === 'S') lat = -Math.abs(lat);
  let lon = Number(row?.lon);
  if (String(row?.['lon-dir']).toUpperCase() === 'W') lon = -Math.abs(lon);
  const day = dayKey(atMs);
  if (!day) return null;
  const vel = Number(row?.vel);
  const altKm = Number(row?.alt);
  return {
    id: `akashic:fireball:${dateStr.replace(/[^0-9]/g, '').slice(0, 14)}`,
    day,
    kind: 'fireball',
    atMs,
    capturedMs,
    title: `Fireball — ${Number.isFinite(energyKt) ? `${energyKt.toFixed(2)} kt` : 'bolide'} atmospheric entry`,
    detail: truncate(
      `Bright meteor detected by US government sensors${Number.isFinite(lat) && Number.isFinite(lon) ? ` near ${lat.toFixed(1)}°, ${lon.toFixed(1)}°` : ''}. Source: NASA CNEOS.`,
      280,
    ),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    severity: 'moderate',
    sources: ['cneos'],
    snapshot: {
      energyKt: Number.isFinite(energyKt) ? energyKt : null,
      radiatedEnergy1e10J: Number.isFinite(Number(row?.energy)) ? Number(row?.energy) : null,
      altitudeKm: Number.isFinite(altKm) ? altKm : null,
      velocityKms: Number.isFinite(vel) ? vel : null,
    },
  };
}

/**
 * CNEOS returns {fields:[...], data:[[row],...]} — rows are arrays.
 * Convert to objects keyed by field name.
 */
export function fireballRowsToObjects(payload) {
  const fields = payload?.fields;
  const rows = payload?.data;
  if (!Array.isArray(fields) || !Array.isArray(rows)) return [];
  return rows
    .filter((r) => Array.isArray(r))
    .map((r) => {
      const obj = {};
      for (let i = 0; i < fields.length; i += 1) obj[String(fields[i])] = r[i];
      return obj;
    });
}

/** Build a launch record from an /api/launches LL2 result. Null when undated. */
export function launchRecord(item, capturedMs = Date.now()) {
  const net = text(item?.net, '');
  const atMs = Date.parse(net);
  if (!Number.isFinite(atMs)) return null;
  const day = dayKey(atMs);
  if (!day) return null;
  const id = `akashic:launch:${text(item?.id, net)}`;
  const pad = item?.pad ?? {};
  const lat = Number(pad?.latitude);
  const lon = Number(pad?.longitude);
  return {
    id,
    day,
    kind: 'launch',
    atMs,
    capturedMs,
    title: truncate(`Launch — ${text(item?.name, 'unnamed mission')}`, 120),
    detail: truncate(
      `${text(item?.launch_service_provider?.name, 'Unknown provider')}${text(item?.mission?.orbit?.name) ? ` → ${item.mission.orbit.name}` : ''}. Status: ${text(item?.status?.name, 'unknown')}.`,
      280,
    ),
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    severity: 'moderate',
    sources: ['launch-library-2'],
    snapshot: {
      name: text(item?.name, ''),
      net,
      status: text(item?.status?.name, ''),
      provider: text(item?.launch_service_provider?.name, ''),
    },
  };
}

/** Build a storm record from a cyclone/storm object. Null when below threshold. */
export function stormRecord(storm, capturedMs = Date.now()) {
  const lat = Number(storm?.lat ?? storm?.position?.latitude);
  const lon = Number(storm?.lon ?? storm?.position?.longitude);
  const windKt = Number(storm?.windKt ?? storm?.wind_kt);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Number.isFinite(windKt) && windKt < SIGNIFICANCE.STORM_WIND_KT_MIN) return null;
  const atMs = Number.isFinite(storm?.atMs) ? storm.atMs : capturedMs;
  const day = dayKey(atMs);
  if (!day) return null;
  const name = text(storm?.name, 'Unnamed storm');
  return {
    id: `akashic:storm:${text(storm?.id, name).replace(/[^a-zA-Z0-9-]/g, '')}-${day}`,
    day,
    kind: 'storm',
    atMs,
    capturedMs,
    title: truncate(`${name} — ${text(storm?.classification, 'tropical system')}`, 120),
    detail: truncate(
      `Hurricane-force system${Number.isFinite(windKt) ? ` with ${Math.round(windKt)} kt winds` : ''}. Source: NHC.`,
      280,
    ),
    lat,
    lon,
    severity: windKt >= 96 ? 'critical' : 'high',
    sources: ['nhc'],
    snapshot: {
      name,
      classification: text(storm?.classification, ''),
      windKt: Number.isFinite(windKt) ? windKt : null,
    },
  };
}

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'SATWQ-Akashic/1.0' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Poll every source, convert to records, archive into the store.
 * Returns { added, duplicates, invalid, errors } — never throws.
 */
export async function runArchiveSweep(store, { fetchImpl = fetchJson } = {}) {
  const summary = { added: 0, duplicates: 0, invalid: 0, errors: 0 };
  const now = Date.now();

  const sweep = async (label, url, itemsOf, toRecord) => {
    let payload = null;
    try {
      payload = await fetchImpl(url);
    } catch {
      summary.errors += 1;
      return;
    }
    if (!payload) {
      summary.errors += 1;
      return;
    }
    let items = [];
    try {
      items = itemsOf(payload) || [];
    } catch {
      summary.errors += 1;
      return;
    }
    for (const item of items) {
      let rec = null;
      try {
        rec = toRecord(item, now);
      } catch {
        summary.invalid += 1;
        continue;
      }
      if (!rec) continue; // below significance — not an error
      const result = store.archive(rec);
      if (result === 'added') summary.added += 1;
      else if (result === 'duplicate') summary.duplicates += 1;
      else summary.invalid += 1;
    }
  };

  await sweep('quakes', USGS_QUAKES_URL, (p) => p?.features, quakeRecord);
  await sweep('alerts', NWS_ALERTS_URL, (p) => p?.features, nwsAlertRecord);
  await sweep('incidents', '/api/events', (p) => p?.incidents, incidentRecord);
  await sweep('fireballs', FIREBALL_URL, fireballRowsToObjects, fireballRecord);
  await sweep('launches', '/api/launches', (p) => p?.results ?? p?.launches, launchRecord);
  await sweep('storms', '/api/cyclones', (p) => p?.storms ?? p?.cyclones, stormRecord);

  return summary;
}
