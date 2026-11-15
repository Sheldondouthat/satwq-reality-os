/**
 * Wave 6 — WSPR live propagation-spot proxy (keyless, non-commercial).
 *
 * wspr.live mirrors the full wsprnet.org WSPR spot firehose (2.7B+ row
 * archive) as a read-only ClickHouse HTTP interface at db1.wspr.live:
 * no authentication, SQL via GET ?query=, ~20 req/min ceiling, terms
 * NON-COMMERCIAL USE ONLY. This provider issues exactly one bounded
 * query — trailing 1 hour, newest first, LIMIT 1500 — and trims each
 * spot to globe-sized fields. Frequencies are normalized to MHz here
 * (Amendment 9: conversion at the adapter, never in a face); times are
 * emitted as ISO-8601 UTC from the ClickHouse timestamp.
 *
 * Routes:
 *   GET /api/wspr-live → {generatedAt, windowSec, count, droppedNoCoords, spots:[...]}
 *
 * Spot shape: {id, time, txCall, txLat, txLon, rxCall, rxLat, rxLon,
 *   freqMHz, snrDb, drift, powerDbm}
 *
 * Schema pinned against a live DESCRIBE on 2026-11-15 (BM4 §2.1 —
 * DESCRIBE wins over the spec's assumed columns):
 *   id UInt64, time DateTime, band Int16,
 *   rx_sign LowCardinality(String), rx_lat Float32, rx_lon Float32,
 *   rx_loc LowCardinality(String),
 *   tx_sign LowCardinality(String), tx_lat Float32, tx_lon Float32,
 *   tx_loc LowCardinality(String),
 *   distance UInt16, azimuth UInt16, rx_azimuth UInt16,
 *   frequency UInt64, power Int8, snr Int8, drift Int8,
 *   version LowCardinality(String), code Int8
 * Deviation from BM4 §2.2's draft query: the frequency column is named
 * `frequency` (Hz), not `freq`. Spots missing either endpoint's
 * coordinates are dropped (an arc needs two ends) and counted in
 * `droppedNoCoords` — never silently; a (0, 0) endpoint pair counts as
 * missing (no WSPR station sits in the Gulf of Guinea null-island).
 *
 * Atlas operating rule: poll ≥3 min, cache off-device, attribute.
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge per the 2026-09-27 edge incident —
 * no node: imports, no WASM).
 */

const UPSTREAM_BASE = 'https://db1.wspr.live/';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024;
const CACHE_TTL_MS = 3 * 60_000; // atlas rule: poll ≥3 min (~20 req/min ceiling)
const WINDOW_SEC = 3600;
const MAX_SPOTS = 1500;
const USER_AGENT = 'Gods Eye View (amateur WSPR context)';

// Pinned to the DESCRIBE output above (2026-11-15). Read-only, single
// statement, server-side window — no LIMIT-less query leaves this provider.
const SPOT_QUERY =
  'SELECT id, time, tx_sign, tx_lat, tx_lon, rx_sign, rx_lat, rx_lon, ' +
  'frequency, snr, drift, power FROM wspr.rx ' +
  'WHERE time > now() - INTERVAL 1 HOUR ORDER BY time DESC ' +
  `LIMIT ${MAX_SPOTS} FORMAT JSONEachRow`;
const UPSTREAM_URL = `${UPSTREAM_BASE}?query=${encodeURIComponent(SPOT_QUERY)}`;

let cache = null; // {at, payload}
let inflight = null;

async function fetchTextCapped(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json, text/plain',
      },
    });
    if (!response.ok)
      throw Object.assign(new Error(`wspr_upstream_${response.status}`), {
        status: 502,
      });
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error('wspr_upstream_too_large'), {
        status: 502,
      });
    return new TextDecoder().decode(buffer);
  } finally {
    clearTimeout(timeout);
  }
}

function roundNum(value, decimals = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** ClickHouse DateTime ("2026-11-15 07:12:00", UTC) → ISO-8601 UTC. */
function toIsoUtc(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const iso = value.includes('T') ? value : value.replace(' ', 'T');
  const zoned = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(zoned);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function validCoord(lat, lon) {
  return (
    typeof lat === 'number' &&
    Number.isFinite(lat) &&
    typeof lon === 'number' &&
    Number.isFinite(lon) &&
    lat >= -90 &&
    lat <= 90 &&
    lon >= -180 &&
    lon <= 180 &&
    !(lat === 0 && lon === 0)
  );
}

function parseRow(row) {
  if (!row || typeof row !== 'object') return null;
  const txLat = Number(row.tx_lat);
  const txLon = Number(row.tx_lon);
  const rxLat = Number(row.rx_lat);
  const rxLon = Number(row.rx_lon);
  if (!validCoord(txLat, txLon) || !validCoord(rxLat, rxLon)) return null;
  const freqHz = Number(row.frequency);
  const time = toIsoUtc(row.time);
  if (!time) return null;
  return {
    id: Number(row.id),
    time,
    txCall: String(row.tx_sign ?? '').slice(0, 16),
    txLat: roundNum(txLat),
    txLon: roundNum(txLon),
    rxCall: String(row.rx_sign ?? '').slice(0, 16),
    rxLat: roundNum(rxLat),
    rxLon: roundNum(rxLon),
    freqMHz:
      Number.isFinite(freqHz) && freqHz > 0 ? roundNum(freqHz / 1e6, 4) : null,
    snrDb: Number.isFinite(Number(row.snr)) ? Number(row.snr) : null,
    drift: Number.isFinite(Number(row.drift)) ? Number(row.drift) : null,
    powerDbm: Number.isFinite(Number(row.power)) ? Number(row.power) : null,
  };
}

/**
 * Parse the JSONEachRow spot stream. Returns {spots, droppedNoCoords}:
 * rows that fail JSON parsing are skipped; rows whose endpoints lack
 * usable coordinates are counted as dropped, never silently.
 */
function parseWsprText(text) {
  const spots = [];
  let droppedNoCoords = 0;
  let sawJson = false;
  if (typeof text !== 'string' || !text) return { spots, droppedNoCoords };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let row;
    try {
      row = JSON.parse(trimmed);
    } catch {
      continue;
    }
    sawJson = true;
    const spot = parseRow(row);
    if (!spot) {
      droppedNoCoords += 1;
      continue;
    }
    spots.push(spot);
    if (spots.length >= MAX_SPOTS) break;
  }
  // A non-empty body with zero parseable rows is an upstream shape
  // failure (e.g. a ClickHouse exception page), not an empty hour.
  if (!sawJson && text.trim())
    throw Object.assign(new Error('wspr_upstream_bad_payload'), {
      status: 502,
    });
  return { spots, droppedNoCoords };
}

/** Pure row parser for tests: JSONEachRow text → trimmed spot array. */
export function parseWsprRows(text) {
  return parseWsprText(text).spots;
}

export function trimWsprPayload(text) {
  const { spots, droppedNoCoords } = parseWsprText(text);
  return {
    generatedAt: new Date().toISOString(),
    windowSec: WINDOW_SEC,
    count: spots.length,
    droppedNoCoords,
    spots,
    note: 'WSPR spots via wspr.live (mirror of wsprnet.org), trailing 1h, newest first. Spots missing either endpoint\'s coordinates are dropped and counted in droppedNoCoords.',
    source: 'wspr.live (non-commercial use only; please respect the ~20 req/min ceiling)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = fetchTextCapped(UPSTREAM_URL)
      .then((text) => {
        const payload = trimWsprPayload(text);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=180') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the WSPR live-spot proxy. Mirrors the pskreporter provider shape. */
export function wsprProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await getSnapshot());
    } catch (error) {
      const upstreamFail =
        error?.status === 502 ||
        error?.name === 'AbortError' ||
        /aborted?/i.test(error?.message ?? '');
      sendJson(
        res,
        upstreamFail ? 502 : 500,
        {
          error: 'wspr_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'wspr',
    configureServer({ middlewares }) {
      middlewares.use('/api/wspr-live', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/wspr-live', handler);
    },
  };
}

export const _wsprInternals = {
  parseWsprRows,
  trimWsprPayload,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
