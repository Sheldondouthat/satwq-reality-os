/**
 * Wave 3 Track 2c / 2.17 — AISHub receiver-station infrastructure map.
 *
 * VERIFIED 2026-09-27: https://www.aishub.net/stations/export-json returns
 * keyless JSON (array of receiver stations: id, country, location,
 * latitude, longitude, unix_time). Stations only — live vessel positions
 * require a feeder account and are NOT pursued (dossier constraint).
 *
 * Renders the volunteer AIS receiver mesh as globe markers: ambient
 * infrastructure metadata, no content, no tracking of vessels.
 * Keyless, plain fetch + JSON (workerd-safe).
 */
import { createKeylessProxy, fetchUpstreamText } from './lib/proxy.js';

const URL = 'https://www.aishub.net/stations/export-json';
const USER_AGENT =
  'SATWQ-RealityOS/1.0 (AISHub public station export; keyless; contact via repo)';

const CACHE_TTL_MS = 30 * 60_000;
const STALE_MS = 6 * 60 * 60_000;
const UPSTREAM_TIMEOUT_MS = 25_000;
const TEXT_CAP = 2 * 1024 * 1024;
const MAX_STATIONS = 3000;

/** Normalize one station row; null when unusable. Exported for tests. */
export function normalizeAishubStation(row) {
  if (!row || typeof row !== 'object') return null;
  const lat = +row.latitude;
  const lon = +row.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat === 0 && lon === 0) return null; // unset / roaming placeholders
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return {
    id: String(row.id ?? '').slice(0, 32),
    country:
      String(row.country ?? '')
        .trim()
        .toLowerCase()
        .slice(0, 8) || null,
    location:
      String(row.location ?? '')
        .trim()
        .slice(0, 120) || null,
    lat: Math.round(lat * 1e4) / 1e4,
    lon: Math.round(lon * 1e4) / 1e4,
    lastSeen: Number.isFinite(+row.unix_time) ? +row.unix_time : null,
  };
}

export function parseAishubStations(text) {
  const doc = JSON.parse(text);
  if (!Array.isArray(doc)) throw new Error('aishub_not_array');
  const stations = [];
  let zeroed = 0;
  for (const row of doc) {
    if (+row?.latitude === 0 && +row?.longitude === 0) {
      zeroed++;
      continue;
    }
    const s = normalizeAishubStation(row);
    if (s) stations.push(s);
    else zeroed++;
    if (stations.length >= MAX_STATIONS) break;
  }
  return { stations, zeroed, reported: doc.length };
}

export function aishubProxy({
  fetchImpl = fetch,
  now = () => Date.now(),
} = {}) {
  async function fetchUpstream({ fetchImpl: f, signal, now: n }) {
    const text = await fetchUpstreamText(f, URL, {
      signal,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      textCap: TEXT_CAP,
      userAgent: USER_AGENT,
      accept: 'application/json',
    });
    const { stations, zeroed, reported } = parseAishubStations(text);
    const byCountry = {};
    for (const s of stations) {
      if (s.country) byCountry[s.country] = (byCountry[s.country] ?? 0) + 1;
    }
    return {
      fetchedAt: n(),
      reported,
      placed: stations.length,
      zeroed,
      byCountry,
      stations,
    };
  }

  function describe(payload, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source: 'AISHub receiver-station export via local proxy',
      attribution:
        'Station data © AISHub contributors. Receiver infrastructure only — ' +
        'live vessel positions require a feeder account and are not collected.',
      fetchedAt: payload?.fetchedAt ?? null,
      stale,
      unavailable: !payload,
      reason,
      reported: payload?.reported ?? 0,
      placed: payload?.placed ?? 0,
      zeroed: payload?.zeroed ?? 0,
      byCountry: payload?.byCountry ?? {},
      stations: payload?.stations ?? [],
    };
  }

  return createKeylessProxy({
    name: 'aishub',
    route: '/api/aishub',
    ttlMs: CACHE_TTL_MS,
    staleMs: STALE_MS,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    fetchUpstream,
    describe,
    fetchImpl,
    now,
  });
}
