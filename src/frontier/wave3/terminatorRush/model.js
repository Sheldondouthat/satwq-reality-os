/**
 * Terminator Rush — event band logic (no Cesium, testable in plain Node).
 *
 * Pins live events (fires, quakes/incidents, NWS alerts, squawks) that lie
 * on the civil-twilight terminator band (solar elevation −6° ± 2°).
 */
import {
  solarElevation,
  onTerminatorBand,
  TERMINATOR_CENTER_ELEV,
  TERMINATOR_HALF_WIDTH,
} from './solar.js';
import { alertCentroid } from '../nwsAlerts/model.js';

export const MAX_PINS = 200;

/** Tolerant event normalization: {lat,lon} | {latitude,longitude} | GeoJSON feature. */
export function normalizeEvent(raw, kind = 'event', source = 'unknown') {
  if (!raw || typeof raw !== 'object') return null;
  let lat = raw.lat ?? raw.latitude ?? null;
  let lon = raw.lon ?? raw.longitude ?? null;
  if ((lat === null || lon === null) && raw.geometry?.type === 'Point') {
    [lon, lat] = raw.geometry.coordinates ?? [];
  }
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return {
    lat,
    lon,
    kind,
    source,
    label: String(
      raw.label ??
        raw.title ??
        raw.event ??
        raw.headline ??
        raw.name ??
        `${kind} event`,
    ).slice(0, 160),
  };
}

function firmsEvents(fires) {
  return (fires ?? [])
    .map((f) =>
      normalizeEvent(
        {
          lat: f.lat,
          lon: f.lon,
          label: `Fire hotspot${f.confidence ? ` (${f.confidence})` : ''}`,
        },
        'fire',
        'FIRMS',
      ),
    )
    .filter(Boolean);
}

function incidentsEvents(incidents) {
  return (incidents ?? [])
    .map((i) =>
      normalizeEvent(
        {
          ...i,
          label: i.title ?? i.label ?? `Incident (${i.kind ?? 'unknown'})`,
        },
        'incident',
        'event-synthesis',
      ),
    )
    .filter(Boolean);
}

function alertsEvents(alerts) {
  return (alerts ?? [])
    .map((a) => {
      const center = alertCentroid(a);
      if (!center) return null;
      return normalizeEvent(
        { ...center, label: `${a.event ?? 'Alert'} — ${a.severity ?? ''}` },
        'alert',
        'NWS',
      );
    })
    .filter(Boolean);
}

function squawkEvents(alerts) {
  return (alerts ?? [])
    .map((s) =>
      normalizeEvent(
        { ...s, label: `Squawk ${s.squawk ?? ''} ${s.callsign ?? ''}`.trim() },
        'squawk',
        'sky-alerts',
      ),
    )
    .filter(Boolean);
}

async function fetchJson(fetchImpl, url) {
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

/**
 * Gather live events from existing feeds. Each feed is best-effort;
 * failures are reported in degradedSources, never thrown.
 */
export async function fetchBandEvents({ fetchImpl = fetch } = {}) {
  const events = [];
  const degradedSources = [];
  const jobs = [
    {
      name: 'firms',
      run: async () => {
        const payload = await fetchJson(fetchImpl, '/api/firms');
        const fires = payload?.fires ?? payload?.hotspots ?? [];
        events.push(...firmsEvents(fires));
      },
    },
    {
      name: 'event-synthesis',
      run: async () => {
        const payload = await fetchJson(fetchImpl, '/api/events');
        events.push(...incidentsEvents(payload?.incidents ?? []));
      },
    },
    {
      name: 'nws-alerts',
      run: async () => {
        const payload = await fetchJson(fetchImpl, '/api/nws-alerts');
        events.push(...alertsEvents(payload?.alerts ?? []));
      },
    },
    {
      name: 'sky-alerts',
      run: async () => {
        const payload = await fetchJson(fetchImpl, '/api/sky-alerts');
        events.push(...squawkEvents(payload?.alerts ?? []));
      },
    },
  ];
  for (const job of jobs) {
    try {
      await job.run();
    } catch (error) {
      degradedSources.push({
        source: job.name,
        reason: error?.message ?? 'unknown',
      });
    }
  }
  return { events, degradedSources };
}

/** Filter events to those on the terminator band at `date`, capped. */
export function eventsOnBand(
  events,
  date,
  center = TERMINATOR_CENTER_ELEV,
  half = TERMINATOR_HALF_WIDTH,
) {
  const out = [];
  for (const event of events ?? []) {
    if (!event || !Number.isFinite(event.lat) || !Number.isFinite(event.lon))
      continue;
    const elevation = solarElevation(event.lat, event.lon, date);
    if (onTerminatorBand(elevation, center, half)) {
      out.push({ ...event, solarElevation: elevation });
    }
  }
  return out.slice(0, MAX_PINS);
}
