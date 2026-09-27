/**
 * Volcano infrasound — Track 3b item 3.8 ("hear eruptions pressurize").
 *
 * VERIFIED 2026-09-27: EarthScope FDSN web services are keyless —
 *   station/1/query returns BDF (infrasound) channels for the AV
 *   (Alaska Volcano Observatory) network, and dataselect/1/query returns
 *   HTTP 200 with real miniSEED for e.g. AV.AU22..BDF (36 KB for 5 min).
 *   (MUSTANG precomputed metrics are retired on service.earthscope.org —
 *   204 even for IU.ANMO BHZ — so this provider decodes miniSEED itself.)
 *
 * Pipeline (all pure JS, no WASM, no node: imports — Pages-safe):
 *   1. station metadata → authoritative lat/lon + counts-per-Pa scale
 *   2. dataselect → 10-min miniSEED window (Steim-2)
 *   3. ./miniseed.js → raw counts → Pa via the SEED scale factor
 *   4. RMS / peak / downsampled envelope → JSON
 *
 * The miniSEED decoder was validated against the live AV.AU22 payload:
 * 72/72 records, decoded sample count == header nsamp sum, inter-record
 * continuity, RMS 4.09 Pa / peak 15.7 Pa (physically plausible infrasound).
 * Steim-2 table ported from EarthScope libmseed's msr_decode_steim2
 * (dnib lives in bits 31-30 of the data word; first-frame dummy diff skipped).
 *
 * Routes:
 *   GET /api/infrasound          → per-station pressure state + envelopes
 *   on unexpected failure → 503 {"error":"infrasound_unavailable"};
 *   upstream outages degrade softly to per-station error states (HTTP 200).
 *
 * Physics honesty: infrasound amplitude is real measured pressure. Volcano
 * names are INFERRED from AVO station prefixes (AU→Augustine); coordinates
 * are authoritative from FDSN station metadata. "Pressurizing" is an
 * interpretation of rising RMS, labeled as such.
 *
 * @returns {import('vite').Plugin}
 */
import { decodeMiniseed, rmsPeak } from './miniseed.js';

const STATION_URL = 'https://service.earthscope.org/fdsnws/station/1/query';
const DATASELECT_URL = 'https://service.earthscope.org/fdsnws/dataselect/1/query';

export const INFRASOUND_ROUTE = '/api/infrasound';

/** Curated volcano-co-located infrasound stations (net/sta). Coordinates and
 *  scale are resolved live from FDSN station metadata — this list only seeds
 *  the query. volcanoHint is INFERRED from AVO naming, never asserted. */
const STATIONS = [
  { net: 'AV', sta: 'AU22', volcanoHint: 'Augustine Volcano (inferred)' },
  { net: 'AV', sta: 'AULG', volcanoHint: 'Augustine Volcano (inferred)' },
  { net: 'AV', sta: 'ANNQ', volcanoHint: null },
  { net: 'AV', sta: 'CEPE', volcanoHint: null },
  { net: 'AV', sta: 'CERB', volcanoHint: null },
  { net: 'AV', sta: 'CLCL', volcanoHint: null },
];

const WINDOW_MS = 10 * 60_000;
const LAG_MS = 120_000; // allow for telemetry latency
const ENVELOPE_BINS = 120;
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 5 * 60_000;
const USER_AGENT =
  'SATWQ-Reality-OS/1.0 (keyless volcano infrasound context; contact: public repo)';
const HONESTY =
  'Pressure amplitudes are real measurements from EarthScope/FDSN infrasound ' +
  '(BDF) channels, converted counts→Pa via each channel\u2019s SEED scale ' +
  'factor. Volcano names are inferred from AVO station prefixes; coordinates ' +
  'are authoritative FDSN metadata. Rising RMS suggests pressurization but is ' +
  'not a eruption prediction.';

/** Parse FDSN station text rows → {lat, lon, scale} for the first BDF epoch.
 *  scale = counts per Pa (column 11 of the FDSN text format). */
export function parseStationText(text, sta) {
  if (typeof text !== 'string') return null;
  const lines = text.split('\n').filter((l) => l && !l.startsWith('#'));
  for (const line of lines) {
    const cols = line.split('|').map((c) => c.trim());
    // Network | Station | Location | Channel | Latitude | Longitude | ... | Scale | ...
    if (cols[1] === sta && cols[3] === 'BDF') {
      const lat = Number(cols[4]);
      const lon = Number(cols[5]);
      // cols: 0 Network|1 Station|2 Location|3 Channel|4 Lat|5 Lon|6 Elev|
      // 7 Depth|8 Azimuth|9 Dip|10 SensorDescription|11 Scale (counts/Pa)|
      // 12 ScaleFreq|13 ScaleUnits|14 SampleRate|15 StartTime|16 EndTime
      const scale = Number(cols[11]); // counts per Pa at ScaleFreq
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return {
          lat,
          lon,
          scale: Number.isFinite(scale) && scale > 0 ? scale : null,
        };
      }
    }
  }
  return null;
}

/** Downsample |samples| to `bins` peak-hold envelope values (in Pa). */
export function envelopePa(samples, scale, bins = ENVELOPE_BINS) {
  if (!samples || !samples.length || !scale) return [];
  const out = new Array(bins).fill(0);
  const per = samples.length / bins;
  for (let b = 0; b < bins; b++) {
    const lo = Math.floor(b * per);
    const hi = Math.max(lo + 1, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = lo; i < hi && i < samples.length; i++) {
      const a = Math.abs(samples[i]) / scale;
      if (a > peak) peak = a;
    }
    out[b] = Math.round(peak * 1000) / 1000;
  }
  return out;
}

/** Classify pressure state from RMS (Pa). Thresholds are heuristic, labeled. */
export function pressureState(rmsPa) {
  if (!Number.isFinite(rmsPa)) return 'unknown';
  if (rmsPa >= 10) return 'loud';
  if (rmsPa >= 2) return 'elevated';
  if (rmsPa >= 0.2) return 'active';
  return 'quiet';
}

async function fetchText(url, fetchImpl, signal, cap = BODY_CAP_BYTES) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal,
  });
  if (res.status === 204) return null; // valid query, no data
  if (!res.ok) throw new Error(`FDSN HTTP ${res.status} for ${url}`);
  const text = await res.text();
  if (text.length > cap) throw new Error('FDSN payload exceeds cap');
  return text;
}

async function fetchBytes(url, fetchImpl, signal, cap = BODY_CAP_BYTES) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal,
  });
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`FDSN HTTP ${res.status} for ${url}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength > cap) throw new Error('FDSN payload exceeds cap');
  return buf;
}

function isoMs(d) {
  return new Date(d).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function infrasoundProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  ttlMs = CACHE_TTL_MS,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  let mem = null;
  let inflight = null;

  async function stationMeta(entry, signal) {
    const url =
      `${STATION_URL}?net=${entry.net}&sta=${entry.sta}&cha=BDF` +
      `&level=channel&format=text`;
    const text = await fetchText(url, fetchImpl, signal, 256 * 1024);
    return parseStationText(text || '', entry.sta);
  }

  async function stationWindow(entry, meta, signal) {
    const end = Date.now() - LAG_MS;
    const start = end - WINDOW_MS;
    const url =
      `${DATASELECT_URL}?net=${entry.net}&sta=${entry.sta}&cha=BDF` +
      `&starttime=${isoMs(start)}&endtime=${isoMs(end)}`;
    const buf = await fetchBytes(url, fetchImpl, signal);
    if (!buf) return { state: 'no_data', meta };
    let records;
    try {
      records = decodeMiniseed(buf);
    } catch (err) {
      return { state: 'decode_error', meta, detail: err?.message };
    }
    if (!records.length) return { state: 'no_data', meta };
    const total = records.reduce((a, r) => a + r.samples.length, 0);
    const joined = new Int32Array(total);
    let o = 0;
    for (const r of records) {
      joined.set(r.samples, o);
      o += r.samples.length;
    }
    const { rms, peak } = rmsPeak(joined);
    const scale = meta.scale;
    const rmsPa = scale ? rms / scale : null;
    const peakPa = scale ? peak / scale : null;
    return {
      state: 'live',
      meta,
      sampleRateHz: records[0].header.sampleRateHz,
      nSamples: total,
      rmsPa: rmsPa === null ? null : Math.round(rmsPa * 10000) / 10000,
      peakPa: peakPa === null ? null : Math.round(peakPa * 1000) / 1000,
      pressure: pressureState(rmsPa),
      envelopePa: envelopePa(joined, scale),
      windowStartUtc: new Date(start).toISOString(),
      windowEndUtc: new Date(end).toISOString(),
    };
  }

  async function refreshUpstream() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const stations = [];
      for (const entry of STATIONS) {
        try {
          const meta = await stationMeta(entry, controller.signal);
          if (!meta) {
            stations.push({ net: entry.net, sta: entry.sta, state: 'no_station' });
            continue;
          }
          const win = await stationWindow(entry, meta, controller.signal);
          stations.push({
            net: entry.net,
            sta: entry.sta,
            lat: meta.lat,
            lon: meta.lon,
            volcanoHint: entry.volcanoHint,
            ...win,
          });
        } catch (err) {
          stations.push({
            net: entry.net,
            sta: entry.sta,
            state: 'error',
            detail: err?.message || 'fetch failed',
          });
        }
      }
      return { at: Date.now(), stations };
    } finally {
      clearTimeout(timer);
    }
  }

  function refreshSingleFlight() {
    if (!inflight) {
      inflight = refreshUpstream().finally(() => {
        inflight = null;
      });
    }
    return inflight;
  }

  const installMiddleware = (server) => {
    server.middlewares.use(INFRASOUND_ROUTE, async (req, res) => {
      const sendJson = (status, bodyObj) => {
        if (res.headersSent) return;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(bodyObj));
      };
      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        const now = Date.now();
        if (!mem || now - mem.at > ttlMs) {
          try {
            mem = await refreshSingleFlight();
          } catch (err) {
            console.warn('[infrasound-proxy] upstream failed:', err?.message || err);
            if (!mem) {
              sendJson(503, { error: 'infrasound_unavailable' });
              return;
            }
          }
        }
        sendJson(200, {
          generatedAt: new Date(mem.at).toISOString(),
          stations: mem.stations,
          honesty: HONESTY,
        });
      } catch (err) {
        console.error('[infrasound-proxy] request failed');
        sendJson(500, { error: 'infrasound proxy error' });
      }
    });
  };

  return {
    name: 'infrasound-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
