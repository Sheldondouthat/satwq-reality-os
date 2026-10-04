/**
 * Wave D — EarthScope IMS infrasound waveform provider (catalog item 66, #49).
 *
 * WHY NOT miniSEED: the FDSN dataselect endpoint returns miniSEED by default,
 * which is a binary format — not edge-parseable (no node: imports, no WASM
 * allowed in providers). Probed live 2026-09-27: the same endpoint supports
 * `format=geocsv.slist` — a pure-text GeoCSV 2.0 time series (header comment
 * lines + one integer sample per line). This provider fetches THAT format, so
 * the waveform is genuinely live at the edge, no snapshot pipeline needed.
 * `format=text` was rejected by the service (422) — only the miniseed,
 * geocsv variants, and sac.zip are accepted, verified against the live error doc.
 *
 * Upstream (verified 2026-09-27):
 *   https://service.earthscope.org/fdsnws/dataselect/1/query
 *   ?network=IM&station=I53H1&channel=BDF&starttime=…&endtime=…&format=geocsv.slist
 * Returns 20 Hz infrasound samples in counts from the I53US IMS array
 * (Fairbanks, AK). Keyless, open, cite the IM network.
 *
 * Calibration honesty: the header carries `scale_factor` + `scale_units: Pa`.
 * We report pressure as counts/scale_factor under a stated linear-calibration
 * assumption (SEED convention), and always ship the raw counts alongside.
 *
 * ROUTE NOTE: /api/infrasound is already owned by wave3/infrasound.js
 * (Alaska Volcano Observatory stations, miniSEED via a pure-JS decoder).
 * This provider is a DIFFERENT upstream and data product (the I53US IMS
 * infrasound array, fetched in text geocsv.slist format), so it mounts
 * /api/infrasound-ims instead. Coordinator: merge/alias as the frontend needs.
 *
 * Routes:
 *   GET /api/infrasound-ims → { generatedAt, stale, station:{…}, stats:{…}, series:{…}, attribution }
 * Query: ?station=I53H1..I53H8 (default I53H1), ?minutes=1..10 (default 5).
 *
 * Keyless, cite EarthScope/IM network, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053), no node: imports, no WASM).
 */

import { readResponseTextCapped } from '../common/http.js';

const DATASELECT_URL =
  'https://service.earthscope.org/fdsnws/dataselect/1/query';
const NETWORK = 'IM';
const CHANNEL = 'BDF';
const STATIONS = [
  'I53H1',
  'I53H2',
  'I53H3',
  'I53H4',
  'I53H5',
  'I53H6',
  'I53H7',
  'I53H8',
];
const DEFAULT_STATION = 'I53H1';
const DEFAULT_MINUTES = 5;
const MAX_MINUTES = 10;
const UPSTREAM_TIMEOUT_MS = 25_000;
const BODY_CAP_BYTES = 512 * 1024; // 10 min @ 20 Hz ≈ 60 KB as text; generous headroom
const CACHE_TTL_MS = 60_000;
const RETRY_COOLDOWN_MS = 60_000;
const STALE_MS = 15 * 60_000;
const MIN_SAMPLES = 20; // a 1-min request at 20 Hz yields 1200; 20 is the sanity floor
const SERIES_MAX_POINTS = 300; // downsampled pressure series for chart consumers
const USER_AGENT = 'Gods Eye View (EarthScope IMS infrasound layer)';

let cache = null; // {at, key, payload}
let inflight = null; // {key, promise}
let attemptedAt = -Infinity;

/** Parse a GeoCSV 2.0 slist document (pure text). Throws {status:502} on bad shape. */
export function parseGeoCsvSlist(text) {
  const fail = (msg) =>
    Object.assign(new Error(`infrasound_geocsv_invalid: ${msg}`), {
      status: 502,
    });
  const lines = text.split('\n');
  const header = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#')) break;
    const body = line.slice(1).trim();
    const sep = body.indexOf(':');
    if (sep > 0) header[body.slice(0, sep).trim()] = body.slice(sep + 1).trim();
  }
  if (header.dataset !== 'GeoCSV 2.0')
    throw fail(`dataset is ${JSON.stringify(header.dataset)}`);
  const columnLine = (lines[i] ?? '').trim();
  if (columnLine.toLowerCase() !== 'sample')
    throw fail(`expected "Sample" column, got ${JSON.stringify(columnLine)}`);
  i++;
  const samples = [];
  for (; i < lines.length; i++) {
    const s = lines[i].trim();
    if (!s) continue;
    const v = Number(s);
    if (!Number.isFinite(v))
      throw fail(`non-numeric sample ${JSON.stringify(s)}`);
    samples.push(v);
  }
  if (samples.length < MIN_SAMPLES)
    throw fail(
      `only ${samples.length} samples (min ${MIN_SAMPLES}) — window likely empty upstream`,
    );
  const sampleRateHz = Number(header.sample_rate_hz);
  const startMs = Date.parse(header.start_time);
  const scaleFactor = Number(header.scale_factor);
  if (!Number.isFinite(sampleRateHz) || sampleRateHz <= 0)
    throw fail('bad sample_rate_hz');
  if (!Number.isFinite(startMs)) throw fail('bad start_time');
  if (!Number.isFinite(scaleFactor) || scaleFactor === 0)
    throw fail('bad scale_factor');
  return {
    sid: header.SID ?? null,
    instrument: header.instrument ?? null,
    lat: Number(header.latitude_deg),
    lon: Number(header.longitude_deg),
    elevationM: Number(header.elevation_m),
    sampleRateHz,
    startMs,
    scaleFactor,
    scaleUnits: header.scale_units ?? null,
    fieldUnit: header.field_unit ?? null,
    headerSampleCount: Number(header.sample_count),
    samples,
  };
}

/**
 * Downsample a sample array to at most maxPoints by striding; returns the
 * stride so consumers can reconstruct timing.
 */
export function downsample(samples, maxPoints = SERIES_MAX_POINTS) {
  if (samples.length <= maxPoints)
    return { stride: 1, values: samples.slice() };
  const stride = Math.ceil(samples.length / maxPoints);
  const values = [];
  for (let i = 0; i < samples.length; i += stride) values.push(samples[i]);
  return { stride, values };
}

function summarize(values) {
  let min = Infinity,
    max = -Infinity,
    sum = 0,
    sumSq = 0;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / values.length;
  return { min, max, mean, rms: Math.sqrt(sumSq / values.length) };
}

/** Build the publishable payload from a parsed GeoCSV document. Pure. */
export function buildInfrasoundPayload(parsed, { station, minutes, nowMs }) {
  const toPa = (counts) => counts / parsed.scaleFactor;
  const countStats = summarize(parsed.samples);
  const pa = (s) => ({
    min: toPa(s.min),
    max: toPa(s.max),
    mean: toPa(s.mean),
    rms: toPa(s.rms),
  });
  const { stride, values } = downsample(parsed.samples);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    stale: false,
    station: {
      network: NETWORK,
      station,
      channel: CHANNEL,
      sid: parsed.sid,
      lat: parsed.lat,
      lon: parsed.lon,
      elevationM: parsed.elevationM,
      instrument: parsed.instrument,
    },
    acquisition: {
      windowMinutes: minutes,
      sampleRateHz: parsed.sampleRateHz,
      startTime: new Date(parsed.startMs).toISOString(),
      endTime: new Date(
        parsed.startMs + (parsed.samples.length / parsed.sampleRateHz) * 1000,
      ).toISOString(),
      headerSampleCount: parsed.headerSampleCount,
      actualSampleCount: parsed.samples.length,
    },
    stats: {
      counts: countStats,
      pascals: pa(countStats),
      pascalsNote:
        'counts divided by header scale_factor (linear-calibration assumption, SEED convention); ' +
        `scale_units=${parsed.scaleUnits ?? 'unknown'}, scale_factor=${parsed.scaleFactor}`,
    },
    series: {
      startTime: new Date(parsed.startMs).toISOString(),
      sampleRateHz: parsed.sampleRateHz,
      stride,
      valuesPa: values.map(toPa),
    },
    attribution:
      'Infrasound waveform: EarthScope FDSN dataselect, IMS network IM station ' +
      `${station} (I53US array, Fairbanks AK). Keyless/open; cite EarthScope and the IM network. ` +
      'Fetched live in text GeoCSV (geocsv.slist) format because miniSEED binary is not edge-parseable.',
  };
}

export function buildDataselectUrl({ station, minutes, endMs }) {
  const end = new Date(endMs);
  const start = new Date(endMs - minutes * 60_000);
  const fmt = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const params = new URLSearchParams({
    network: NETWORK,
    station,
    channel: CHANNEL,
    starttime: fmt(start),
    endtime: fmt(end),
    format: 'geocsv.slist',
  });
  return `${DATASELECT_URL}?${params.toString()}`;
}

function parseQuery(url) {
  const params = new URL(url, 'http://localhost').searchParams;
  const station = (params.get('station') ?? DEFAULT_STATION).toUpperCase();
  if (!STATIONS.includes(station))
    throw Object.assign(new Error(`infrasound_bad_station: ${station}`), {
      status: 400,
    });
  const minutes = Number(params.get('minutes') ?? DEFAULT_MINUTES);
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > MAX_MINUTES)
    throw Object.assign(
      new Error(`infrasound_bad_minutes: ${params.get('minutes')}`),
      { status: 400 },
    );
  return { station, minutes: Math.floor(minutes) };
}

async function fetchUpstream(fetchImpl, { station, minutes, endMs }) {
  const url = buildDataselectUrl({ station, minutes, endMs });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053). EarthScope redirects
      // http→https, so follow is required here.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv, text/plain' },
    });
    if (res.status === 204)
      throw Object.assign(new Error('infrasound_no_data_in_window'), {
        status: 502,
      });
    if (!res.ok)
      throw Object.assign(new Error(`infrasound_upstream_${res.status}`), {
        status: 502,
      });
    const text = await readResponseTextCapped(res, BODY_CAP_BYTES); // throws when too large
    const parsed = parseGeoCsvSlist(text); // throws {status:502} on bad shape
    return buildInfrasoundPayload(parsed, { station, minutes, nowMs: endMs });
  } finally {
    clearTimeout(timer);
  }
}

function sendJson(res, status, body, cacheControl = 'public, max-age=60') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

async function getPayload(fetchImpl, query, nowMs, signal) {
  const key = `${query.station}:${query.minutes}`;
  if (cache && cache.key === key && nowMs - cache.at < CACHE_TTL_MS)
    return {
      ...cache.payload,
      generatedAt: new Date(nowMs).toISOString(),
      stale: false,
    };
  signal?.throwIfAborted?.();
  if (!inflight || inflight.key !== key) {
    if (nowMs - attemptedAt < RETRY_COOLDOWN_MS)
      throw new Error('infrasound_retry_later');
    attemptedAt = nowMs;
    const promise = fetchUpstream(fetchImpl, { ...query, endMs: nowMs })
      .then((payload) => {
        cache = { at: nowMs, key, payload };
        return payload;
      })
      .finally(() => {
        if (inflight?.key === key) inflight = null;
      });
    inflight = { key, promise };
  }
  const wait = inflight.promise;
  if (!signal) return wait;
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', abort, { once: true });
    const detach = () => signal.removeEventListener('abort', abort);
    wait.then(detach, detach);
  });
  return Promise.race([wait, cancelled]);
}

export function infrasoundProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    const controller = new AbortController();
    const close = () => controller.abort();
    res.once?.('close', close);
    try {
      let query;
      try {
        query = parseQuery(req.url);
        query.key = query.station
          ? `${query.station}:${query.minutes}`
          : `${query.id}:${query.hours}`;
      } catch (error) {
        return sendJson(
          res,
          400,
          { error: 'infrasound_bad_request', detail: error.message },
          'no-store',
        );
      }
      try {
        const payload = await getPayload(
          fetchImpl,
          query,
          now(),
          controller.signal,
        );
        sendJson(res, 200, payload);
      } catch (error) {
        // Stale fallback is key-scoped: only serve a cache entry captured for THIS query.
        const usable =
          cache && cache.key === query.key && now() - cache.at <= STALE_MS;
        if (usable) {
          sendJson(res, 200, {
            ...cache.payload,
            generatedAt: new Date(now()).toISOString(),
            stale: true,
          });
          return;
        }
        const upstreamFail =
          error?.status === 502 ||
          error?.name === 'AbortError' ||
          /aborted?/i.test(error?.message ?? '');
        sendJson(
          res,
          upstreamFail ? 502 : 500,
          {
            error: 'infrasound_unavailable',
            detail: error?.message ?? 'unknown',
          },
          'no-store',
        );
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'infrasoundIms',
    configureServer({ middlewares }) {
      middlewares.use('/api/infrasound-ims', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/infrasound-ims', handler);
    },
  };
}

export const _infrasoundInternals = {
  DATASELECT_URL,
  STATIONS,
  parseGeoCsvSlist,
  downsample,
  buildInfrasoundPayload,
  buildDataselectUrl,
  clearCaches: () => {
    cache = null;
    inflight = null;
    attemptedAt = -Infinity;
  },
};
