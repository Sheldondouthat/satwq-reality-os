/**
 * Argo float provider (keyless).
 *
 * Upstream: Ifremer ERDDAP, https://erddap.ifremer.fr/erddap/ (anonymous,
 * DOC-VERIFIED 2026-09-27). TableDAP dataset `ArgoFloats` (one row per
 * profile level; ~4,000 drifting profilers, ~10-day cycle).
 *
 * Two light queries per refresh:
 *   1. positions: platform_number,time,latitude,longitude,position_qc
 *      &time>=<cutoff>&distinct()              → latest fix per float
 *   2. surface temp: platform_number,time,temp
 *      &time>=<cutoff>&pres<5&orderByLimit("time,15000")
 *      → median near-surface temp per float (best effort; may be partial)
 *
 * Physics honesty: `surfaceTempC` is a sampled median of near-surface
 * (<5 dbar) measurements in the window, NOT a calibrated SST product and
 * NOT necessarily co-located in time with `t`. Positions are float fixes;
 * drift between fixes is unknown (floats surface ~every 10 days).
 *
 * Consumer contract (worker W10 — ocean-twin UX):
 *   GET /api/argo?days=30 → JSON
 *   {
 *     fetchedAt, windowDays, ttlMs, stale,
 *     floats: [{
 *       wmo, lat, lon, t, qc, profilesInWindow, surfaceTempC
 *     }],
 *     tempCoverage: 0..1,   // fraction of floats with a temp sample
 *     unavailable, reason
 *   }
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, no node: imports, no WASM).
 */

const ERDDAP_BASE = 'https://erddap.ifremer.fr/erddap/tabledap/ArgoFloats.json';
const UPSTREAM_TIMEOUT_MS = 30_000;
const BODY_CAP_BYTES = 1536 * 1024;
const USER_AGENT = 'SATWQ Reality OS (public Argo/ERDDAP context)';
const CACHE_TTL_MS = 30 * 60 * 1000;
const DEFAULT_DAYS = 30;
const MAX_DAYS = 90;
const TEMP_ROW_LIMIT = 15000;
// The pres<5 temp scan is expensive on ERDDAP (~35 s for 1 day, verified
// 2026-09-27); keep it to a dedicated short window with its own timeout so
// the positions product is never held hostage by it.
const TEMP_WINDOW_DAYS = 1;
const TEMP_TIMEOUT_MS = 45_000;

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=900' : 'no-store',
  });
  res.end(JSON.stringify(payload));
}

async function fetchJsonCapped(fetchImpl, url, maxBytes, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    if (!response.ok)
      throw Object.assign(new Error(`argo_upstream_${response.status}`), {
        status: 502,
      });
    const text = await response.text();
    if (text.length > maxBytes)
      throw Object.assign(new Error('argo_upstream_too_large'), {
        status: 502,
      });
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

function tableRows(doc) {
  const table = doc?.table;
  if (!table || !Array.isArray(table.columnNames) || !Array.isArray(table.rows))
    return null;
  const idx = {};
  table.columnNames.forEach((c, i) => {
    idx[c] = i;
  });
  return table.rows.map((row) => {
    const obj = {};
    for (const [name, i] of Object.entries(idx)) obj[name] = row[i];
    return obj;
  });
}

/**
 * Reduce distinct() position rows to the latest fix per float.
 * Pure function — unit-tested.
 */
export function latestFixesPerFloat(rows) {
  const byFloat = new Map();
  for (const r of rows || []) {
    const wmo = String(r.platform_number ?? '').trim();
    // Explicit null guards: Number(null) === 0 would pass isFinite.
    if (r.latitude == null || r.longitude == null) continue;
    const lat = Number(r.latitude);
    const lon = Number(r.longitude);
    const t = String(r.time ?? '');
    if (!wmo || !Number.isFinite(lat) || !Number.isFinite(lon) || !t) continue;
    const prev = byFloat.get(wmo);
    if (!prev || t > prev.t) {
      byFloat.set(wmo, {
        wmo,
        lat,
        lon,
        t,
        qc: r.position_qc ?? null,
        profilesInWindow: (prev?.profilesInWindow || 0) + 1,
      });
    } else {
      prev.profilesInWindow += 1;
    }
  }
  return [...byFloat.values()];
}

/**
 * Median near-surface temperature per float from temp rows.
 * Pure function — unit-tested.
 */
export function medianSurfaceTempPerFloat(rows) {
  const temps = new Map();
  for (const r of rows || []) {
    const wmo = String(r.platform_number ?? '').trim();
    if (r.temp == null) continue; // Number(null) === 0 — reject explicitly
    const temp = Number(r.temp);
    if (!wmo || !Number.isFinite(temp)) continue;
    if (!temps.has(wmo)) temps.set(wmo, []);
    temps.get(wmo).push(temp);
  }
  const out = new Map();
  for (const [wmo, list] of temps) {
    const sorted = list.sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const med =
      sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    out.set(wmo, Math.round(med * 100) / 100);
  }
  return out;
}

export function argoProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  let cache = null; // { key, at, payload }

  async function getSnapshot(days) {
    const key = `days:${days}`;
    const now = Date.now();
    if (cache && cache.key === key && now - cache.at < CACHE_TTL_MS)
      return { ...cache.payload, stale: false };
    try {
      const cutoff = new Date(now - days * 24 * 3600_000).toISOString();
      const tempCutoff = new Date(
        now - TEMP_WINDOW_DAYS * 24 * 3600_000,
      ).toISOString();
      const timeConstraint = `time%3E=${encodeURIComponent(cutoff)}`;
      const posUrl =
        `${ERDDAP_BASE}?platform_number,time,latitude,longitude,position_qc` +
        `&${timeConstraint}&distinct()`;
      const tempUrl =
        `${ERDDAP_BASE}?platform_number,time,temp` +
        `&time%3E=${encodeURIComponent(tempCutoff)}&pres%3C5&orderByLimit(%22time,${TEMP_ROW_LIMIT}%22)`;
      const [posDoc, tempDoc] = await Promise.all([
        fetchJsonCapped(fetchImpl, posUrl, BODY_CAP_BYTES, UPSTREAM_TIMEOUT_MS),
        fetchJsonCapped(
          fetchImpl,
          tempUrl,
          BODY_CAP_BYTES,
          TEMP_TIMEOUT_MS,
        ).catch(
          () => null, // temp is best-effort; positions are the product
        ),
      ]);
      const posRows = tableRows(posDoc);
      if (!posRows)
        throw Object.assign(new Error('argo_malformed_positions'), {
          status: 502,
        });
      const floats = latestFixesPerFloat(posRows);
      const tempByFloat = tempDoc
        ? medianSurfaceTempPerFloat(tableRows(tempDoc) || [])
        : new Map();
      let withTemp = 0;
      for (const f of floats) {
        const t = tempByFloat.get(f.wmo);
        f.surfaceTempC = t === undefined ? null : t;
        if (t !== undefined) withTemp += 1;
      }
      floats.sort((a, b) => (a.t < b.t ? 1 : -1));
      const payload = {
        fetchedAt: now,
        windowDays: days,
        ttlMs: CACHE_TTL_MS,
        stale: false,
        floats,
        tempCoverage: floats.length
          ? Math.round((withTemp / floats.length) * 1000) / 1000
          : 0,
        unavailable: false,
        reason: null,
      };
      cache = { key, at: now, payload };
      return payload;
    } catch (error) {
      if (cache && cache.key === key) return { ...cache.payload, stale: true };
      throw error;
    }
  }

  async function handler(req, res) {
    if (req.method !== 'GET')
      return sendJson(res, 405, { error: 'method_not_allowed' });
    let days = DEFAULT_DAYS;
    try {
      const parsed = new URL(req.url, 'http://localhost');
      const raw = parsed.searchParams.get('days');
      if (raw !== null) {
        const d = Number(raw);
        if (Number.isFinite(d))
          days = Math.min(MAX_DAYS, Math.max(1, Math.floor(d)));
      }
    } catch {
      return sendJson(res, 400, { error: 'argo_bad_request' });
    }
    try {
      sendJson(res, 200, await getSnapshot(days));
    } catch {
      sendJson(res, 502, { error: 'argo_upstream_unavailable' });
    }
  }

  return {
    name: 'argo',
    configureServer({ middlewares }) {
      middlewares.use('/api/argo', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/argo', handler);
    },
  };
}
