/**
 * Wave 9 — Raspberry Shake citizen-seismometer network inventory.
 *
 * Upstream: https://data.raspberryshake.org/fdsnws/station/1/version → 1.1.6
 *   GET https://data.raspberryshake.org/fdsnws/station/1/query?network=AM&level=station&format=text
 *   LIVE-VERIFIED 2026-10-02: HTTP 200, 3,791,438 bytes, 28,214 data rows,
 *   `#Network|Station|Latitude|Longitude|Elevation|SiteName|StartTime|EndTime`.
 *   7,937 unique station codes; 6,228 with an epoch lacking EndTime (open).
 *   The FDSN event service is NOT published (event/1/query → 404 envelope),
 *   and dataselect serves miniSEED waveforms (binary, not edge-parseable) —
 *   so the honest keyless feed is the station registry, not quake catalogs.
 *
 * R2 recursion origin: the honest-failures list probed
 * fdsnws.raspberryshakedata.com for 24 consecutive runs (000); the CURRENT
 * hostname data.raspberryshake.org answers 200 on dataselect AND station.
 *
 * HONESTY: this is REGISTRY metadata (FDSN Station text), not real-time data
 * flow. "active" = the registry lists an epoch with no EndTime — it may lag
 * actual streaming by hours, and a listed-open station can be dark. Station
 * codes repeat across relocation epochs (R0000 has 6); positions are the
 * most recent epoch. Two upstream rows (of 28,214) carry corrupt latitudes
 * (~7.9M); they read null via the range guard, never as real coordinates.
 * Live waveform data is a separate service (fdsnws-dataselect, miniSEED)
 * and is NOT covered by this route.
 */
const UPSTREAM_URL =
  'https://data.raspberryshake.org/fdsnws/station/1/query?network=AM&level=station&format=text';
const UPSTREAM_VERSION_URL = 'https://data.raspberryshake.org/fdsnws/station/1/version';
const USER_AGENT = 'satwq-reality-os/1.0 (+https://satwq-reality-os.pages.dev)';
const UPSTREAM_TIMEOUT_MS = 20000;
const BODY_CAP_BYTES = 8 * 1024 * 1024; // live doc is ~3.8 MB
const CACHE_TTL_MS = 24 * 3600 * 1000; // registry metadata: daily refresh
const STALE_MS = 14 * 24 * 3600 * 1000;
const RETRY_COOLDOWN_MS = 60 * 1000;
const CACHE_CONTROL = 'public, max-age=86400';

const NETWORK = 'AM';
const WEEK_MS = 7 * 24 * 3600 * 1000;
const DENSITY_CELL_DEG = 10;
const BOX_CAP = 500;
const NEAR_DEFAULT = 10;
const NEAR_MAX = 50;
// Real code shapes observed live 2026-10-02: R0000, RBDCC (R+hex), S9F83,
// T150A — always 5 chars, leading letter, uppercase alnum.
const STATION_RE = /^[A-Z][0-9A-Z]{4}$/;

export function numOrNull(v) {
  if (v == null) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null; // empty cell = missing, never 0 (Number('')===0)
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function latOrNull(v) {
  const n = numOrNull(v);
  return n != null && n >= -90 && n <= 90 ? n : null; // corrupt upstream rows (e.g. 7934917.16) → null
}

export function lonOrNull(v) {
  const n = numOrNull(v);
  return n != null && n >= -180 && n <= 180 ? n : null;
}

function parseTs(s) {
  if (typeof s !== 'string' || s.trim() === '') return null;
  const ms = Date.parse(s.trim());
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Parse the FDSN station text doc into per-code station records.
 * Pure — takes nowMs so tests are deterministic.
 */
export function parseStationInventory(text, nowMs) {
  if (typeof text !== 'string' || !text.startsWith('#Network')) {
    throw Object.assign(new Error('rs_bad_inventory_shape'), { status: 502 });
  }
  const stations = new Map(); // code -> {code, epochs:[...]}
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const f = line.split('|');
    if (f.length < 8) continue; // malformed row: skip, never guess
    const code = (f[1] ?? '').trim();
    if (!code) continue;
    const epoch = {
      lat: latOrNull(f[2]),
      lon: lonOrNull(f[3]),
      elevM: numOrNull(f[4]),
      site: (f[5] ?? '').trim() || null,
      startMs: parseTs(f[6]),
      endMs: parseTs(f[7]),
    };
    let st = stations.get(code);
    if (!st) {
      st = { code, epochs: [] };
      stations.set(code, st);
    }
    st.epochs.push(epoch);
  }
  const list = [];
  let active = 0;
  let newWeek = 0;
  let retiredWeek = 0;
  const density = new Map();
  for (const st of stations.values()) {
    st.epochs.sort((a, b) => (a.startMs ?? 0) - (b.startMs ?? 0));
    const latest = st.epochs[st.epochs.length - 1];
    const first = st.epochs[0];
    st.open = st.epochs.some((e) => e.endMs == null);
    st.lat = latest.lat;
    st.lon = latest.lon;
    st.elevM = latest.elevM;
    st.site = latest.site;
    st.firstStartMs = first.startMs;
    st.lastStartMs = latest.startMs;
    st.lastEndMs = latest.endMs;
    if (st.open) {
      active += 1;
      if (st.lat != null && st.lon != null) {
        const cell = `${Math.floor(st.lat / DENSITY_CELL_DEG) * DENSITY_CELL_DEG},${Math.floor(st.lon / DENSITY_CELL_DEG) * DENSITY_CELL_DEG}`;
        density.set(cell, (density.get(cell) ?? 0) + 1);
      }
    }
    if (st.firstStartMs != null && nowMs - st.firstStartMs <= WEEK_MS) newWeek += 1;
    if (!st.open && st.lastEndMs != null && nowMs - st.lastEndMs <= WEEK_MS) retiredWeek += 1;
    list.push(st);
  }
  const densityCells = [...density.entries()]
    .map(([cell, count]) => ({ cell, count }))
    .sort((a, b) => b.count - a.count);
  return {
    stations: list,
    byCode: stations,
    summary: {
      network: NETWORK,
      totalStations: stations.size,
      active,
      dark: stations.size - active,
      newWeek,
      retiredWeek,
      densityCells: densityCells.length,
    },
    density: densityCells,
  };
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const r = (d) => (d * Math.PI) / 180;
  const dLat = r(lat2 - lat1) / 2;
  const dLon = r(lon2 - lon1) / 2;
  const a =
    Math.sin(dLat) ** 2 +
    Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(dLon) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a))); // clamp: float drift near antipodes
}

function stationRow(st) {
  return {
    code: st.code,
    open: st.open,
    lat: st.lat,
    lon: st.lon,
    elevM: st.elevM,
    site: st.site,
    epochs: st.epochs.length,
    firstStart: st.firstStartMs != null ? new Date(st.firstStartMs).toISOString() : null,
    lastEnd: st.lastEndMs != null ? new Date(st.lastEndMs).toISOString() : null,
  };
}

export function buildPayload(doc, query, stale) {
  const station = query.station ?? null;
  const box = query.box ?? null;
  const near = query.near ?? null;
  let stations = null;
  let truncated = false;

  if (station != null) {
    if (!STATION_RE.test(station)) {
      return { status: 400, body: { error: 'rs_bad_station' } };
    }
    const st = doc.byCode.get(station);
    if (!st) {
      return {
        status: 200,
        body: {
          requestedNotFound: true,
          station,
          note: 'Well-formed code, not present in the AM registry snapshot.',
        },
      };
    }
    stations = [stationRow(st)];
  } else if (box != null) {
    const parts = box.split(',').map(Number);
    if (
      parts.length !== 4 ||
      parts.some((p) => !Number.isFinite(p)) ||
      parts[0] < -180 || parts[2] > 180 || parts[1] < -90 || parts[3] > 90 ||
      parts[0] > parts[2] || parts[1] > parts[3]
    ) {
      return { status: 400, body: { error: 'rs_bad_box' } };
    }
    const [minLon, minLat, maxLon, maxLat] = parts;
    const inBox = doc.stations.filter(
      (st) => st.lat != null && st.lon != null &&
        st.lon >= minLon && st.lon <= maxLon && st.lat >= minLat && st.lat <= maxLat
    );
    inBox.sort((a, b) => (a.code < b.code ? -1 : 1));
    truncated = inBox.length > BOX_CAP;
    stations = inBox.slice(0, BOX_CAP).map(stationRow);
  } else if (near != null) {
    const parts = near.split(',').map(Number);
    if (
      parts.length !== 2 || parts.some((p) => !Number.isFinite(p)) ||
      parts[0] < -90 || parts[0] > 90 || parts[1] < -180 || parts[1] > 180
    ) {
      return { status: 400, body: { error: 'rs_bad_near' } };
    }
    let n = query.n != null ? Number(query.n) : NEAR_DEFAULT;
    if (!Number.isFinite(n)) return { status: 400, body: { error: 'rs_bad_n' } };
    n = Math.max(1, Math.min(NEAR_MAX, Math.floor(n)));
    const [lat, lon] = parts;
    stations = doc.stations
      .filter((st) => st.open && st.lat != null && st.lon != null)
      .map((st) => ({ st, km: haversineKm(lat, lon, st.lat, st.lon) }))
      .sort((a, b) => a.km - b.km)
      .slice(0, n)
      .map(({ st, km }) => ({ ...stationRow(st), distKm: Math.round(km * 10) / 10 }));
  }

  return {
    status: 200,
    body: {
      generatedAt: new Date().toISOString(),
      upstream: UPSTREAM_URL,
      upstreamVersion: UPSTREAM_VERSION_URL,
      stale: !!stale,
      network: NETWORK,
      summary: doc.summary,
      ...(stations ? { stations, count: stations.length, truncated } : {}),
      ...(stations ? {} : { density: doc.density }),
      query: {
        ...(station ? { station } : {}),
        ...(box ? { box } : {}),
        ...(near ? { near, n: query.n ?? NEAR_DEFAULT } : {}),
      },
      honesty: {
        registryNotRealtime:
          'FDSN Station registry metadata (text), NOT real-time data flow. Snapshot refreshes daily.',
        activeDefinition:
          '"active" = the registry lists an epoch with no EndTime. It may lag actual streaming by hours; a listed-open station can be dark.',
        epochs:
          'Station codes repeat across relocation epochs (e.g. R0000 has 6); positions are the most recent epoch.',
        corruptRows:
          'Upstream rows with out-of-range coordinates read null, never as real positions (2 of 28,214 rows on 2026-10-02).',
        waveforms:
          'Live waveform data is a separate service (fdsnws-dataselect, miniSEED binary) — not covered by this route.',
        noEventCatalog:
          'Raspberry Shake publishes no FDSN event catalog (event/1/query → 404); this route covers the station network, not quake lists.',
        attribution: 'Data: Raspberry Shake (raspberryshake.org), FDSN station web service.',
      },
    },
  };
}

// --- fetch machinery (wave9 conventions) ---

async function fetchTextCapped(url, capBytes) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge.
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain' },
    });
    if (!response.ok) {
      throw Object.assign(new Error(`rs_upstream_${response.status}`), { status: 502 });
    }
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes)
      throw Object.assign(new Error('rs_upstream_too_large'), { status: 502 });
    return new TextDecoder().decode(buffer);
  } catch (error) {
    if (error?.status === 502) throw error;
    throw Object.assign(new Error(`rs_fetch_failed: ${error?.message ?? 'unknown'}`), { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}

// --- caches (wave9 conventions: one doc per refresh, filtered per query) ---
const docCache = new Map(); // key 'doc' -> {at, doc}
const payloadCache = new Map(); // key -> {at, payload}
const inflight = new Map();
const failedAt = new Map(); // key -> timestamp of last fetch failure

async function getDoc() {
  const key = 'doc';
  const now = Date.now();
  const hit = docCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return { doc: hit.doc, stale: false };
  let op = inflight.get(key);
  if (!op) {
    const lastFail = failedAt.get(key) ?? -Infinity;
    if (now - lastFail < RETRY_COOLDOWN_MS && hit && now - hit.at < STALE_MS) {
      return { doc: hit.doc, stale: true };
    }
    op = (async () => {
      try {
        const text = await fetchTextCapped(UPSTREAM_URL, BODY_CAP_BYTES);
        const doc = parseStationInventory(text, Date.now());
        docCache.set(key, { at: Date.now(), doc });
        return { doc, stale: false };
      } catch (error) {
        failedAt.set(key, Date.now());
        if (hit && Date.now() - hit.at < STALE_MS) return { doc: hit.doc, stale: true };
        throw error;
      }
    })().finally(() => inflight.delete(key));
    inflight.set(key, op);
  }
  return op;
}

async function getPayload(query) {
  const key = JSON.stringify(query);
  const now = Date.now();
  const hit = payloadCache.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.payload;
  const { doc, stale } = await getDoc();
  const result = buildPayload(doc, query, stale);
  if (result.status === 200) payloadCache.set(key, { at: Date.now(), payload: result });
  return result;
}

function sendJson(res, status, body, cacheControl = CACHE_CONTROL) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-9 Raspberry Shake network-inventory proxy. */
export function raspberryShakeProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method_not_allowed' }, 'no-store');
    try {
      const url = new URL(req.url, 'http://localhost');
      const query = {
        station: url.searchParams.get('station'),
        box: url.searchParams.get('box'),
        near: url.searchParams.get('near'),
        n: url.searchParams.get('n'),
      };
      const { status, body } = await getPayload(query);
      sendJson(res, status, body, status === 200 ? CACHE_CONTROL : 'no-store');
    } catch (error) {
      const upstreamFail = error?.status === 502 || error?.name === 'AbortError' || /aborted?/i.test(error?.message ?? '');
      sendJson(res, upstreamFail ? 502 : 500, {
        error: 'rs_unavailable',
        detail: error?.message ?? 'unknown',
        honesty: { attribution: 'Data: Raspberry Shake (raspberryshake.org), FDSN station web service.' },
      }, 'no-store');
    }
  }

  return {
    name: 'raspberryshake',
    configureServer({ middlewares }) {
      middlewares.use('/api/raspberryshake', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/raspberryshake', handler);
    },
  };
}

export const _raspberryShakeInternals = {
  UPSTREAM_URL,
  CACHE_TTL_MS,
  STATION_RE,
  parseStationInventory,
  buildPayload,
  numOrNull,
  latOrNull,
  lonOrNull,
  haversineKm,
  resetCache: () => { docCache.clear(); payloadCache.clear(); inflight.clear(); failedAt.clear(); },
};
