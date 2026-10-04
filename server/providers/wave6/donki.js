/**
 * Wave 6 — NASA DONKI space-weather aggregation proxy (keyless).
 *
 * NASA's Database of Notifications, Knowledge, Information (DONKI) tracks
 * coronal mass ejections, solar flares, geomagnetic storms, and the
 * notification stream around them. Primary path is the CCMC DONKI Web
 * Services endpoint, which serves the identical DONKI schema keyless; the
 * api.nasa.gov DONKI mirror (with NASA's public DEMO_KEY) is a fallback
 * for the same feeds.
 *
 *   #66 CME           https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/CME
 *   #67 CMEAnalysis    https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/CMEAnalysis
 *   #68 FLR (flares)  https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/FLR
 *   #69 GST (storms)  https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/GST
 *   #70 notifications https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/notifications
 *
 * Routes:
 *   GET /api/donki → {generatedAt, sources:{...}, cme:[...], flares:[...], geomagneticStorms:[...], notifications:[...]}
 *
 * CMEAnalysis rows join to CMEs on associatedCMEID → activityID (only the
 * most-accurate analysis per CME is kept). An empty GST array is valid —
 * it means the sun is quiet. Per-source failures are recorded honestly in
 * `sources.<key>.error`; a 502 is returned only when EVERY source fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 */

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 30 * 60_000;
const USER_AGENT = 'Gods Eye View (public space-weather aggregation)';
const DEMO_KEY = 'DEMO_KEY'; // NASA's public demo key — rate-limited, fallback only
const WINDOW_DAYS = 30;
const MAX_CMES = 60;
const MAX_FLARES = 60;
const MAX_STORMS = 20;
const MAX_NOTIFICATIONS = 25;

function isoDateDaysAgo(days) {
  const d = new Date(Date.now() - days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function queryRange() {
  const end = isoDateDaysAgo(0);
  const start = isoDateDaysAgo(WINDOW_DAYS);
  return `startDate=${start}&endDate=${end}`;
}

function ccmcUrls(feed) {
  return [
    `https://kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/${feed}?${queryRange()}`,
    `https://api.nasa.gov/DONKI/${feed}?${queryRange()}&api_key=${DEMO_KEY}`,
  ];
}

const SOURCES = [
  {
    key: 'cme',
    urls: ccmcUrls('CME'),
    parse: parseCme,
    attribution: 'NASA/CCMC DONKI (public domain)',
    joinKey: 'activityID',
  },
  {
    key: 'cmeAnalysis',
    urls: ccmcUrls('CMEAnalysis'),
    parse: parseCmeAnalysis,
    attribution: 'NASA/CCMC DONKI (public domain)',
  },
  {
    key: 'flares',
    urls: ccmcUrls('FLR'),
    parse: parseFlares,
    attribution: 'NASA/CCMC DONKI (public domain)',
  },
  {
    key: 'storms',
    urls: ccmcUrls('GST'),
    parse: parseStorms,
    attribution: 'NASA/CCMC DONKI (public domain)',
  },
  {
    key: 'notifications',
    urls: ccmcUrls('notifications'),
    parse: parseNotifications,
    attribution: 'NASA/CCMC DONKI (public domain)',
  },
];

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function str(value, maxLen) {
  return value == null ? '' : String(value).slice(0, maxLen);
}

function isoOrNull(value) {
  if (value == null || value === '') return null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function instrumentNames(instruments) {
  if (!Array.isArray(instruments)) return [];
  return instruments
    .map((i) => str(i?.displayName, 80))
    .filter(Boolean)
    .slice(0, 8);
}

// ——— parsers (all pure, exported for tests) ———

function parseCme(upstream) {
  const rows = Array.isArray(upstream) ? upstream : [];
  return rows
    .map((r) => ({
      id: str(r?.activityID, 80),
      startTime: isoOrNull(r?.startTime),
      sourceLocation: str(r?.sourceLocation, 40),
      activeRegionNum: isFiniteNum(r?.activeRegionNum)
        ? r.activeRegionNum
        : null,
      instruments: instrumentNames(r?.instruments),
      note: str(r?.note, 500),
      link: str(r?.link, 300),
      analysis: null, // joined later from CMEAnalysis
    }))
    .filter((c) => c.id)
    .sort((a, b) =>
      String(b.startTime ?? '').localeCompare(String(a.startTime ?? '')),
    )
    .slice(0, MAX_CMES);
}

function parseCmeAnalysis(upstream) {
  const rows = Array.isArray(upstream) ? upstream : [];
  const byCme = new Map();
  for (const r of rows) {
    const cmeId = str(r?.associatedCMEID, 80);
    if (!cmeId) continue;
    const prior = byCme.get(cmeId);
    // Prefer the most-accurate analysis; tie-break on later submission.
    const rank = (x) => [x?.isMostAccurate ? 1 : 0, str(x?.submissionTime, 30)];
    const candidate = {
      time21_5: isoOrNull(r?.time21_5),
      latitude: isFiniteNum(r?.latitude) ? r.latitude : null,
      longitude: isFiniteNum(r?.longitude) ? r.longitude : null,
      halfAngle: isFiniteNum(r?.halfAngle) ? r.halfAngle : null,
      speedKms: isFiniteNum(r?.speed) ? r.speed : null,
      type: str(r?.type, 10),
      isMostAccurate: r?.isMostAccurate === true,
      note: str(r?.note, 400),
    };
    if (!prior || JSON.stringify(rank(r)) > JSON.stringify(rank(prior.raw))) {
      byCme.set(cmeId, { analysis: candidate, raw: r });
    }
  }
  const out = new Map();
  for (const [cmeId, { analysis }] of byCme) out.set(cmeId, analysis);
  return out;
}

function parseFlares(upstream) {
  const rows = Array.isArray(upstream) ? upstream : [];
  return rows
    .map((r) => ({
      id: str(r?.flrID, 80),
      beginTime: isoOrNull(r?.beginTime),
      peakTime: isoOrNull(r?.peakTime),
      endTime: isoOrNull(r?.endTime),
      class: str(r?.classType, 12),
      sourceLocation: str(r?.sourceLocation, 40),
      activeRegionNum: isFiniteNum(r?.activeRegionNum)
        ? r.activeRegionNum
        : null,
      instruments: instrumentNames(r?.instruments),
      link: str(r?.link, 300),
    }))
    .filter((f) => f.id)
    .sort((a, b) =>
      String(b.peakTime ?? '').localeCompare(String(a.peakTime ?? '')),
    )
    .slice(0, MAX_FLARES);
}

function parseStorms(upstream) {
  const rows = Array.isArray(upstream) ? upstream : [];
  return rows
    .map((r) => {
      const kp = Array.isArray(r?.allKpIndex) ? r.allKpIndex : [];
      const kpMax = kp.reduce(
        (m, k) => (isFiniteNum(k?.kpIndex) && k.kpIndex > m ? k.kpIndex : m),
        null,
      );
      return {
        id: str(r?.gstID, 80),
        startTime: isoOrNull(r?.startTime),
        kpMax,
        kpSamples: kp.length,
        link: str(r?.link, 300),
      };
    })
    .filter((s) => s.id)
    .sort((a, b) =>
      String(b.startTime ?? '').localeCompare(String(a.startTime ?? '')),
    )
    .slice(0, MAX_STORMS);
}

function parseNotifications(upstream) {
  const rows = Array.isArray(upstream) ? upstream : [];
  return rows
    .map((r) => ({
      id: str(r?.messageID, 80),
      type: str(r?.messageType, 12),
      issueTime: isoOrNull(r?.messageIssueTime),
      url: str(r?.messageURL, 300),
      body: str(r?.messageBody, 1200),
    }))
    .filter((n) => n.id)
    .sort((a, b) =>
      String(b.issueTime ?? '').localeCompare(String(a.issueTime ?? '')),
    )
    .slice(0, MAX_NOTIFICATIONS);
}

// ——— fetching ———

async function fetchJsonFirstOk(sourceKey, urls) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let lastError = null;
  try {
    for (const url of urls) {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
          // 'error' throws at the edge (main 2ec4053). DONKI upstreams were
          // probed 200-OK keyless on 2026-09-27 (this fetch path follows any
          // CDN redirect rather than asserting a fixed host chain).
          redirect: 'follow',
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
        });
        if (!response.ok) {
          lastError = Object.assign(
            new Error(`donki_${sourceKey}_upstream_${response.status}`),
            { status: 502 },
          );
          continue;
        }
        const buffer = await response.arrayBuffer();
        if (buffer.byteLength > BODY_CAP_BYTES) {
          lastError = Object.assign(
            new Error(`donki_${sourceKey}_upstream_too_large`),
            { status: 502 },
          );
          continue;
        }
        return JSON.parse(new TextDecoder().decode(buffer));
      } catch (error) {
        if (error?.status === 502) {
          lastError = error;
          continue;
        }
        throw error; // abort/timeout/network — try the next mirror too
      }
    }
    throw (
      lastError ??
      Object.assign(new Error(`donki_${sourceKey}_all_mirrors_down`), {
        status: 502,
      })
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOneSource(source) {
  const started = Date.now();
  try {
    const upstream = await fetchJsonFirstOk(source.key, source.urls);
    return {
      key: source.key,
      ok: true,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      data: upstream,
    };
  } catch (error) {
    return {
      key: source.key,
      ok: false,
      attribution: source.attribution,
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      data: null,
    };
  }
}

function buildSnapshot(results) {
  const sources = {};
  const parsed = {};
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
    };
    if (r.ok)
      parsed[r.key] = SOURCES.find((s) => s.key === r.key).parse(r.data);
  }

  // Join CMEAnalysis onto CMEs (only when both feeds landed).
  const cmes = parsed.cme ?? [];
  const analyses = parsed.cmeAnalysis;
  if (analyses instanceof Map) {
    for (const cme of cmes) {
      const a = analyses.get(cme.id);
      if (a) cme.analysis = a;
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays: WINDOW_DAYS,
    sources,
    cme: cmes,
    flares: parsed.flares ?? [],
    geomagneticStorms: parsed.storms ?? [],
    notifications: parsed.notifications ?? [],
    source: 'NASA/CCMC DONKI (public domain)',
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all(SOURCES.map(fetchOneSource))
      .then((results) => {
        const ok = results.some((r) => r.ok);
        if (!ok) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`donki_all_upstream_down: ${detail}`), {
            status: 502,
          });
        }
        const payload = buildSnapshot(results);
        cache = { at: Date.now(), payload };
        return payload;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

function sendJson(res, status, body, cacheControl = 'public, max-age=1800') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the DONKI space-weather aggregation proxy. Mirrors the quakes provider shape. */
export function donkiProxy() {
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
          error: 'donki_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'donki',
    configureServer({ middlewares }) {
      middlewares.use('/api/donki', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/donki', handler);
    },
  };
}

export const _donkiInternals = {
  parseCme,
  parseCmeAnalysis,
  parseFlares,
  parseStorms,
  parseNotifications,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
