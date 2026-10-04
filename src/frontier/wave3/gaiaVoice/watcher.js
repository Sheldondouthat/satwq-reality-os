/**
 * Gaia voice — background watcher.
 *
 * Polls the event-synthesis feed plus the direct keyless feeds, classifies
 * new records, and hands speakable ones to the speaker under cooldown/mute.
 * Feed polling is isolated per source: one feed failing never silences the
 * others. Mute persists in localStorage (`satwq.gaia.muted`).
 */
import {
  classifyEvent,
  shouldSpeak,
  markSpoken,
  freshState,
  QUAKE_SPEAK_MAG_MIN,
} from './model.js';
import { createGaiaSpeaker } from './speaker.js';

export const MUTE_KEY = 'satwq.gaia.muted';
export const WATCH_POLL_MS = 60_000;

const USGS_QUAKES_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
// Same-origin proxy: api.weather.gov sends no CORS headers and rejects the
// ?limit= param, so a direct browser fetch is dead two ways.
const NWS_ALERTS_URL = '/api/nws-alerts';

async function fetchJson(url, { timeoutMs = 12000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function readMuted() {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(MUTE_KEY) === '1'
    );
  } catch {
    return false;
  }
}

function writeMuted(muted) {
  try {
    if (typeof localStorage !== 'undefined')
      localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  } catch {
    /* ignore */
  }
}

/** Normalize raw feed items into the classifier's record shape. */
export function normalizeWatchItems({
  quakes = [],
  alerts = [],
  incidents = [],
} = {}) {
  const out = [];
  for (const f of quakes) {
    const props = f?.properties ?? {};
    const mag = Number(props?.mag);
    if (!Number.isFinite(mag) || mag < QUAKE_SPEAK_MAG_MIN) continue;
    out.push({
      id: `gaia:quake:${f?.id ?? `${props?.time ?? ''}`}`,
      kind: 'quake',
      mag,
      place: props?.place,
      lat: f?.geometry?.coordinates?.[1],
      lon: f?.geometry?.coordinates?.[0],
      snapshot: { mag, place: props?.place },
    });
  }
  for (const f of alerts) {
    // Accepts raw NWS GeoJSON features ({properties:{event,…}}) and the
    // server-trimmed /api/nws-alerts shape ({event, areaDesc, …} top-level).
    const props = f?.properties ?? f ?? {};
    if (!props?.event) continue;
    const sentish = props?.sent ?? props?.effective ?? props?.onset ?? '';
    out.push({
      id: `gaia:alert:${
        String(props?.id || '')
          .split('/')
          .pop() || sentish
      }`,
      kind: 'alert',
      event: props.event,
      area: props?.areaDesc,
      snapshot: { event: props.event, areaDesc: props.areaDesc },
    });
  }
  for (const inc of incidents) {
    out.push({
      id: `gaia:incident:${inc?.id}`,
      kind: 'incident',
      severity: inc?.severity,
      title: inc?.title,
    });
  }
  return out;
}

/**
 * Start the ambient watcher. Returns { setMuted, isMuted, stop, _tick }.
 * `speaker` and `fetchImpl` are injectable for tests.
 */
export function startGaiaWatcher({
  pollMs = WATCH_POLL_MS,
  speaker = createGaiaSpeaker(),
  fetchImpl = fetchJson,
} = {}) {
  let state = freshState();
  let muted = readMuted();
  let stopped = false;

  async function tick(nowMs = Date.now()) {
    if (stopped || muted) return { spoken: 0 };
    let items = [];
    try {
      const [quakes, alerts, events] = await Promise.all([
        fetchImpl(USGS_QUAKES_URL).catch(() => null),
        fetchImpl(NWS_ALERTS_URL).catch(() => null),
        fetchImpl('/api/events').catch(() => null),
      ]);
      items = normalizeWatchItems({
        quakes: quakes?.features ?? [],
        // /api/nws-alerts returns server-trimmed alerts ({event, areaDesc, …}
        // at top level, not GeoJSON features with .properties.
        alerts: alerts?.alerts ?? [],
        incidents: events?.incidents ?? [],
      });
    } catch {
      return { spoken: 0 };
    }
    let spoken = 0;
    for (const raw of items) {
      const event = classifyEvent(raw);
      if (!event) continue;
      const decision = shouldSpeak(event, state, nowMs, muted);
      if (!decision.ok) continue;
      if (speaker.speak(event)) {
        state = markSpoken(event, state, nowMs);
        spoken += 1;
      }
    }
    return { spoken };
  }

  const timer =
    typeof setInterval !== 'undefined'
      ? setInterval(() => tick(), pollMs)
      : null;

  return {
    setMuted(m) {
      muted = !!m;
      writeMuted(muted);
      if (muted) speaker.hush();
    },
    isMuted: () => muted,
    stop: () => {
      stopped = true;
      if (timer) clearInterval(timer);
    },
    _tick: tick,
    _state: () => state,
  };
}
