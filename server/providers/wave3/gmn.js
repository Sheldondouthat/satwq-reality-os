/**
 * Wave 3 Track 2c / 2.14 — Global Meteor Network nightly streak arcs.
 *
 * Polls the GMN daily trajectory summary
 * (https://globalmeteornetwork.org/data/traj_summary_data/daily/traj_summary_latest_daily.txt),
 * a tab-delimited (semicolon) table of triangulated meteor trajectories from
 * 500+ volunteer cameras. Each row carries begin/end geodetic coordinates
 * and the UTC time of the event; the frontend keeps the night-side events
 * (dark hemisphere at event time) and draws streak arcs begin -> end.
 *
 * The file is ~0.9 MB/day and regenerated daily: 6 h refresh, 24 h stale.
 * Keyless, plain fetch + text parse (workerd-safe).
 */
import { createKeylessProxy, fetchUpstreamText } from './lib/proxy.js';

const URL =
  'https://globalmeteornetwork.org/data/traj_summary_data/daily/traj_summary_latest_daily.txt';
const USER_AGENT =
  'SATWQ-RealityOS/1.0 (GMN public data; keyless; contact via repo)';

const CACHE_TTL_MS = 6 * 60 * 60_000;
const STALE_MS = 24 * 60 * 60_000;
const UPSTREAM_TIMEOUT_MS = 30_000;
const TEXT_CAP = 4 * 1024 * 1024;
const MAX_METEORS = 500;

// Field positions (0-based) in the traj_summary table.
const F_ID = 0;
const F_UTC = 2; // "2026-09-25 10:14:53.093473"
const F_VINIT = 59;
const F_LAT_BEG = 63;
const F_LON_BEG = 65;
const F_LAT_END = 69;
const F_LON_END = 71;
const F_MASS = 79;

/** Parse "YYYY-MM-DD HH:MM:SS.ffffff" as UTC ms. Exported for tests. */
export function parseGmnUtc(s) {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/.exec(
      String(s ?? '').trim(),
    );
  if (!m) return null;
  const ms = m[7] ? Math.round(Number(`0.${m[7]}`) * 1000) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

/** Normalize one table row; null when unusable. Exported for tests. */
export function normalizeGmnRow(fields) {
  if (!Array.isArray(fields) || fields.length <= F_LON_END) return null;
  const timeMs = parseGmnUtc(fields[F_UTC]);
  const latBeg = +fields[F_LAT_BEG];
  const lonBeg = +fields[F_LON_BEG];
  const latEnd = +fields[F_LAT_END];
  const lonEnd = +fields[F_LON_END];
  if (!Number.isFinite(timeMs)) return null;
  for (const v of [latBeg, lonBeg, latEnd, lonEnd]) {
    if (!Number.isFinite(v)) return null;
  }
  if (Math.abs(latBeg) > 90 || Math.abs(latEnd) > 90) return null;
  if (Math.abs(lonBeg) > 180 || Math.abs(lonEnd) > 180) return null;
  const vInit = Number.isFinite(+fields[F_VINIT]) ? +fields[F_VINIT] : null;
  const massKg = Number.isFinite(+fields[F_MASS]) ? +fields[F_MASS] : null;
  return {
    id:
      String(fields[F_ID] ?? '')
        .trim()
        .slice(0, 64) || null,
    timeMs,
    latBeg: Math.round(latBeg * 1e4) / 1e4,
    lonBeg: Math.round(lonBeg * 1e4) / 1e4,
    latEnd: Math.round(latEnd * 1e4) / 1e4,
    lonEnd: Math.round(lonEnd * 1e4) / 1e4,
    vInitKmS: vInit,
    massKg,
  };
}

export function parseGmnSummary(text) {
  const meteors = [];
  for (const rawLine of String(text).split('\n')) {
    const line = rawLine.replace(/^\uFEFF/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const row = normalizeGmnRow(line.split(';'));
    if (row) meteors.push(row);
    if (meteors.length >= MAX_METEORS * 4) break;
  }
  meteors.sort((a, b) => b.timeMs - a.timeMs);
  return meteors.slice(0, MAX_METEORS);
}

export function gmnProxy({ fetchImpl = fetch, now = () => Date.now() } = {}) {
  async function fetchUpstream({ fetchImpl: f, signal, now: n }) {
    const text = await fetchUpstreamText(f, URL, {
      signal,
      timeoutMs: UPSTREAM_TIMEOUT_MS,
      textCap: TEXT_CAP,
      userAgent: USER_AGENT,
      accept: 'text/plain',
    });
    return { fetchedAt: n(), meteors: parseGmnSummary(text) };
  }

  function describe(payload, { stale = false, reason = null } = {}) {
    return {
      schemaVersion: 1,
      source: 'Global Meteor Network daily trajectory summary via local proxy',
      attribution:
        'Trajectory data © Global Meteor Network contributors (500+ volunteer cameras).',
      fetchedAt: payload?.fetchedAt ?? null,
      stale,
      unavailable: !payload,
      reason,
      count: payload?.meteors?.length ?? 0,
      meteors: payload?.meteors ?? [],
    };
  }

  return createKeylessProxy({
    name: 'gmn',
    route: '/api/meteors',
    ttlMs: CACHE_TTL_MS,
    staleMs: STALE_MS,
    timeoutMs: UPSTREAM_TIMEOUT_MS,
    fetchUpstream,
    describe,
    fetchImpl,
    now,
  });
}
