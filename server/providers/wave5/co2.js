/**
 * NOAA GML daily Mauna Loa CO₂ proxy (keyless) — planetary vital-sign ticker.
 *
 * Upstream: https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.csv
 * (verified live 2026-09-27; CSV rows: year,month,day,decimalDate,dailyMeanPpm;
 * -999.99 flags a missing day). The CSV is one file for the whole record,
 * so the provider parses the tail: latest daily mean + same-date last-year
 * delta.
 *
 * Routes:
 *   GET /api/co2 → {generatedAt, ppm, date, delta1yPpm, unit, source, attribution, honesty}
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'error' pinned host, no node: imports, no WASM).
 */

import {
  fetchTextCapped,
  makeCache,
  numOrNull,
  sendJson,
  buildProxy,
} from './_lib.js';

const UPSTREAM_URL =
  'https://gml.noaa.gov/webdata/ccgg/trends/co2/co2_daily_mlo.csv';
const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 2 * 1024 * 1024; // full-record CSV is ~450 KB
const CACHE_TTL_MS = 6 * 3600_000; // daily series; 6h keeps it fresh
const MISSING_PPM = -999.99;
const SOURCE = 'NOAA Global Monitoring Laboratory — Mauna Loa';
const ATTRIBUTION = 'NOAA GML (U.S. government data, public domain)';

/** Parse the daily CO₂ CSV into [{year,month,day,decimalDate,ppm}], newest last. */
export function parseCo2Csv(text) {
  const rows = [];
  for (const line of String(text).split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const parts = t.split(',').map((p) => p.trim());
    if (parts.length < 5) continue;
    const [year, month, day, decimalDate] = parts.map(Number);
    const ppm = numOrNull(parts[4]);
    if (![year, month, day, decimalDate].every(Number.isFinite) || ppm === null)
      continue;
    if (ppm === MISSING_PPM) continue; // missing-data flag, not a measurement
    rows.push({ year, month, day, decimalDate, ppm });
  }
  return rows;
}

/** Latest row plus the same-calendar-date row from the previous year (if present). */
export function pickLatestAndYearAgo(rows) {
  if (!rows.length) return { latest: null, yearAgo: null };
  const latest = rows[rows.length - 1];
  // Prefer the exact same month/day one year earlier…
  let yearAgo = rows.find(
    (r) =>
      r.year === latest.year - 1 &&
      r.month === latest.month &&
      r.day === latest.day,
  );
  // …otherwise the nearest measurement within ±8 days of decimalDate-1.
  if (!yearAgo) {
    let best = null;
    let bestGap = 8 / 365.25;
    for (const r of rows) {
      if (r === latest) continue;
      const gap = Math.abs(r.decimalDate - (latest.decimalDate - 1));
      if (gap <= bestGap) {
        best = r;
        bestGap = gap;
      }
    }
    yearAgo = best ?? null;
  }
  return { latest, yearAgo };
}

export function trimCo2Payload(text) {
  const rows = parseCo2Csv(text);
  const { latest, yearAgo } = pickLatestAndYearAgo(rows);
  if (!latest) throw Object.assign(new Error('co2_no_rows'), { status: 502 });
  const delta1yPpm =
    yearAgo != null ? Math.round((latest.ppm - yearAgo.ppm) * 100) / 100 : null;
  const date = `${String(latest.year).padStart(4, '0')}-${String(latest.month).padStart(2, '0')}-${String(latest.day).padStart(2, '0')}`;
  return {
    generatedAt: new Date().toISOString(),
    value: latest.ppm,
    ppm: latest.ppm,
    date,
    delta1yPpm,
    delta1yDate:
      yearAgo != null
        ? `${yearAgo.year}-${String(yearAgo.month).padStart(2, '0')}-${String(yearAgo.day).padStart(2, '0')}`
        : null,
    unit: 'ppm',
    source: SOURCE,
    attribution: ATTRIBUTION,
    honesty:
      'Daily mean CO₂ at Mauna Loa; -999.99 flags missing days and is excluded. ' +
      'Year-ago delta uses the nearest measurement within ±8 days when the exact date is missing.',
  };
}

const cache = makeCache(
  async () =>
    trimCo2Payload(
      await fetchTextCapped({
        url: UPSTREAM_URL,
        timeoutMs: UPSTREAM_TIMEOUT_MS,
        bodyCapBytes: BODY_CAP_BYTES,
        accept: 'text/csv',
        label: 'co2',
      }),
    ),
  CACHE_TTL_MS,
);

/** Mount the CO₂ proxy. Mirrors the vaac/nwsAlerts provider shape. */
export function co2Proxy() {
  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      sendJson(res, 200, await cache.get(), 'public, max-age=21600');
    } catch (error) {
      sendJson(
        res,
        error?.status === 502 ? 502 : 500,
        { error: 'co2_unavailable', detail: error?.message ?? 'unknown' },
        'no-store',
      );
    }
  }
  return buildProxy({ name: 'co2', route: '/api/co2', handler });
}

export const _co2Internals = {
  parseCo2Csv,
  pickLatestAndYearAgo,
  trimCo2Payload,
  clearCaches: () => cache.clear(),
};
