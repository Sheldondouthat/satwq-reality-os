/**
 * Wave 5 — phone-as-weather-station (backlog R2-24).
 *
 * The S21's barometer (STMicro LPS22HH) becomes a Wave5 citizen-station feed
 * at /api/phone-sensors. Readings are polled on the VM every ~3 minutes by
 * the phone-sensors estate (~/workspace/phone-sensors/) and served from the
 * VM-local state file — the phone's live data NEVER leaves the VM.
 *
 * PRIVACY (hard, by design):
 *  - This provider serves PRESSURE ONLY. GPS coordinates are stripped even
 *    if the state file carries them: lat/lon are ALWAYS null here.
 *  - The provider is EXCLUDED from the Cloudflare Pages registry by design
 *    (same exclusion class as local-receivers: unreachable from the edge).
 *    The full feed (pressure + position dot) renders ONLY on the private
 *    key-gated ONE PULSE plane (~/workspace/one-pulse/), never on the
 *    public site.
 *
 * SHAPE: Wave5 station document, same contract as /api/wxstations:
 *   { generatedAt, count, sources:[...], stations:[{
 *       source, id, name, lat, lon, pressureHpa, timeMs, kind }] }
 * lat/lon are null by the privacy rule above (never coordApprox games).
 *
 * FRESHNESS: a reading older than FRESH_MS (5 min) is served with stale:true
 * (Wave5 stale-while-flagged convention). No state file at all -> honest
 * {unavailable:true}, never fake rows.
 */

const FRESH_MS = 5 * 60_000;
const STALE_CAP_MS = 60 * 60_000; // beyond 1h the reading is dropped, not flagged

/** Finite number or null. null/undefined/'' stay null — never 0. */
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Build the payload from a state object. Pure — exported for tests.
 * state: { pressure_hpa, pressure_ts_ms, poll_ts_ms } (GPS fields, if
 * present, are deliberately IGNORED — this endpoint never carries them).
 */
function buildPayload(state, { now = () => Date.now() } = {}) {
  const t = now();
  const pressure = num(state?.pressure_hpa);
  const pts = Number.isFinite(state?.pressure_ts_ms) ? state.pressure_ts_ms : null;
  const ageMs = pts == null ? null : Math.max(0, t - pts);

  const base = {
    schemaVersion: 1,
    generatedAt: new Date(t).toISOString(),
    provider: 'phone-sensors',
    backlog: 'R2-24',
  };

  if (pressure == null || ageMs == null || ageMs > STALE_CAP_MS) {
    return {
      ...base,
      count: 0,
      sources: [{
        id: 's21-barometer', name: 'S21 barometer (LPS22HH)', kind: 'obs',
        status: 'unavailable', count: 0,
      }],
      stations: [],
      stale: false,
      unavailable: true,
      reason: 'No phone barometer reading on the VM (poller dark or phone unreachable).',
      attribution: 'S21 barometer, polled on the VM. Pressure only — position never leaves the private plane.',
    };
  }

  return {
    ...base,
    count: 1,
    sources: [{
      id: 's21-barometer', name: 'S21 barometer (LPS22HH)', kind: 'obs',
      status: 'ok', count: 1,
    }],
    stations: [{
      source: 's21-barometer',
      id: 's21',
      name: 'S21 · phone barometer',
      lat: null, // privacy: coordinates never served here, even when known
      lon: null,
      tempC: null,
      windMs: null,
      windDirDeg: null,
      rhPct: null,
      pressureHpa: pressure,
      timeMs: pts,
      kind: 'obs',
      coordApprox: false,
    }],
    stale: ageMs > FRESH_MS,
    unavailable: false,
    reason: ageMs > FRESH_MS ? 'Reading older than 5 min; showing last known.' : null,
    readingAgeMs: ageMs,
    attribution: 'S21 barometer (STMicro LPS22HH via Termux sensor API), polled on the VM. '
      + 'Pressure only — GPS position renders solely on the private key-gated plane.',
  };
}

/**
 * Default state reader: VM-local JSON file. The path comes from
 * PHONE_SENSORS_STATE_FILE (absolute). node:fs is imported lazily so the
 * module graph stays workerd-safe if anyone ever loads it on the edge —
 * though the provider is excluded from the Pages registry by design.
 */
async function defaultReadState() {
  const file = process.env.PHONE_SENSORS_STATE_FILE;
  if (!file) return null;
  try {
    const fs = await import('node:fs/promises');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

export function phoneSensorsProxy({ readState = defaultReadState, now = () => Date.now() } = {}) {
  async function handler(req, res) {
    const json = (status, value) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    try {
      if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
      const state = await readState().catch(() => null);
      json(200, buildPayload(state, { now }));
    } catch (error) {
      json(500, { error: 'internal server error' });
    }
  }

  return {
    name: 'phone-sensors',
    configureServer({ middlewares }) {
      middlewares.use('/api/phone-sensors', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/phone-sensors', handler);
    },
  };
}

export const _phoneSensorsInternals = { num, buildPayload, FRESH_MS, STALE_CAP_MS };
