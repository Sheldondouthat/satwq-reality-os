/**
 * Wave 6 — wildfire aggregation proxy (all keyless).
 *
 * Merges two US wildfire sources into one normalized snapshot:
 *
 *   #130 NOAA HMS https://satepsanone.nesdis.noaa.gov/pub/FIRE/HMS/latesthms.txt
 *        CSV-ish text of satellite fire detections (lon/lat/satellite/method).
 *        OBSERVED 2026-09-27: the "latest" file is FROZEN — HTTP Last-Modified
 *        is 2022-07-18 and every row carries YearDay 2022199, so the provider
 *        labels the source vintage/staleNote honestly instead of pretending
 *        the detections are current.
 *   #131 NIFC DCAT https://data-nifc.opendata.arcgis.com/api/feed/dcat-us/1.1.json
 *        The DCAT catalog is used for SERVICE DISCOVERY (per catalog note):
 *        the provider picks the preferred WFIGS incident-locations dataset
 *        ("Current Wildland Fire Incident Locations" first) and queries its
 *        ArcGIS FeatureServer layer for live incident points (f=geojson).
 *
 * Routes:
 *   GET /api/fires → {generatedAt, sources:{...}, count, counts:{...}, fires:[...]}
 *
 * Each entry is normalized to {id, kind:'incident'|'detection', lat, lon, name,
 * ...} and near-duplicate HMS detections (same satellite, ~100 m) are merged.
 * Per-source failures are recorded honestly in `sources.<key>.error`; a 502 is
 * returned only when EVERY source fails.
 *
 * Keyless, no new dependencies, Pages-safe (global fetch only, capped
 * reads, redirect:'follow' — workerd supports only 'follow'/'manual';
 * 'error' throws at the edge (main 2ec4053) — no node: imports, no WASM).
 */

const HMS_URL =
  'https://satepsanone.nesdis.noaa.gov/pub/FIRE/HMS/latesthms.txt';
const NIFC_DCAT_URL =
  'https://data-nifc.opendata.arcgis.com/api/feed/dcat-us/1.1.json';

// DCAT dataset title preference, most-current first.
const NIFC_TITLE_PREFERENCE = [
  'Current Wildland Fire Incident Locations',
  'New Starts - Wildland Fire Incident Locations (Last 24 Hours)',
  '2026 Wildland Fire Incident Locations to Date',
  'Wildland Fire Incident Locations',
];

const NIFC_OUT_FIELDS = [
  'IrwinID',
  'IncidentName',
  'IncidentTypeCategory',
  'IncidentSize',
  'FireDiscoveryDateTime',
  'PercentContained',
  'POOState',
  'POOCounty',
  'FireCause',
  'FireMgmtComplexity',
  'GACC',
].join(',');

const UPSTREAM_TIMEOUT_MS = 20_000;
const BODY_CAP_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 15 * 60_000;
const MAX_HMS_DETECTIONS = 2_500;
const MAX_NIFC_INCIDENTS = 500;
const USER_AGENT = 'Gods Eye View (public wildfire aggregation)';

let cache = null; // {at, payload}
let inflight = null;

function isFiniteNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function roundNum(value, decimals = 4) {
  if (!isFiniteNum(value)) return value;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function finiteOrNull(value, decimals = 4) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? roundNum(n, decimals) : null;
}

function clampLatLon(lat, lon) {
  if (!isFiniteNum(lat) || !isFiniteNum(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

/** YYYYDDD ("2022199") → ISO date string, or null. */
function yearDayToIso(yearDay) {
  const m = String(yearDay ?? '')
    .trim()
    .match(/^(\d{4})(\d{3})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const day = Number(m[2]);
  if (year < 1900 || year > 2100 || day < 1 || day > 366) return null;
  return new Date(Date.UTC(year, 0, day)).toISOString();
}

/** Wrap fetch with timeout + byte cap; returns {kind:'json'|'text', data, headers}. */
async function fetchCapped(sourceKey, url, kind, accept) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      // NOTE: redirect:'follow' — workerd supports only 'follow'/'manual';
      // 'error' throws at the edge (main 2ec4053).
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: accept },
    });
    if (!response.ok)
      throw Object.assign(
        new Error(`fires_${sourceKey}_upstream_${response.status}`),
        { status: 502 },
      );
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > BODY_CAP_BYTES)
      throw Object.assign(new Error(`fires_${sourceKey}_upstream_too_large`), {
        status: 502,
      });
    const text = new TextDecoder().decode(buffer);
    return {
      data: kind === 'json' ? JSON.parse(text) : text,
      headers: response.headers,
    };
  } finally {
    clearTimeout(timeout);
  }
}

// ——— NOAA HMS parsing (pure, exported for tests) ———

/**
 * Parse HMS latesthms.txt. First line is a header
 * ("Lon, Lat, YearDay, Time, Satellite, Method of Detect, Ecosys, Fire RadPower");
 * rows are comma-separated with no quoted commas observed.
 */
export function parseHmsText(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    const cols = line.split(',').map((c) => c.trim());
    if (cols.length < 8) continue;
    const lon = Number(cols[0]);
    const lat = Number(cols[1]);
    const ll = clampLatLon(lat, lon);
    if (!ll) continue;
    const yearDay = cols[2];
    const satellite = cols[4];
    const frp =
      cols[7] === '-999' || cols[7] === '-999.000'
        ? null
        : finiteOrNull(cols[7], 3);
    out.push({
      id: `hms:${satellite.replace(/\s+/g, '')}:${roundNum(ll.lon)}:${roundNum(ll.lat)}:${yearDay}`,
      kind: 'detection',
      lat: roundNum(ll.lat),
      lon: roundNum(ll.lon),
      satellite,
      method: cols[5] || null,
      ecoRegion: finiteOrNull(cols[6], 0),
      fireRadiativePower: frp,
      yearDay,
      date: yearDayToIso(yearDay),
      timeHhmm: cols[3] || null,
      sources: ['hms'],
    });
  }
  return out;
}

/**
 * Merge near-duplicate HMS detections: same satellite and detection point
 * within ~0.001° (~110 m) keep the row with the strongest FRP.
 */
export function dedupeHmsDetections(detections) {
  const byKey = new Map();
  for (const d of detections) {
    const key = `${d.satellite}|${roundNum(d.lat, 3)}|${roundNum(d.lon, 3)}`;
    const prior = byKey.get(key);
    if (
      !prior ||
      (d.fireRadiativePower ?? -1) > (prior.fireRadiativePower ?? -1)
    ) {
      byKey.set(key, d);
    }
  }
  return [...byKey.values()];
}

// ——— NIFC DCAT discovery + WFIGS incident parsing (pure, exported for tests) ———

/**
 * From a parsed NIFC DCAT feed, pick the preferred WFIGS incident-locations
 * FeatureServer service URL (service discovery, not hardcoded).
 */
export function discoverNifcIncidentService(dcat) {
  const datasets = Array.isArray(dcat?.dataset) ? dcat.dataset : [];
  const ranked = [];
  for (const ds of datasets) {
    const title = String(ds?.title ?? '');
    const pref = NIFC_TITLE_PREFERENCE.indexOf(title);
    if (pref < 0) continue;
    const dists = Array.isArray(ds.distribution) ? ds.distribution : [];
    for (const dist of dists) {
      const accessURL = String(dist?.accessURL ?? dist?.downloadURL ?? '');
      if (
        dist?.mediaType === 'application/json' &&
        /FeatureServer/i.test(accessURL)
      ) {
        ranked.push({ pref, title, serviceUrl: accessURL.replace(/\/$/, '') });
      }
    }
  }
  ranked.sort((a, b) => a.pref - b.pref);
  return ranked[0] ?? null;
}

function buildNifcQueryUrl(serviceUrl) {
  const params = new URLSearchParams({
    where: '1=1',
    outFields: NIFC_OUT_FIELDS,
    returnGeometry: 'true',
    outSR: '4326',
    f: 'geojson',
    orderByFields: 'FireDiscoveryDateTime DESC',
    resultRecordCount: String(MAX_NIFC_INCIDENTS),
  });
  return `${serviceUrl}/query?${params.toString()}`;
}

export function parseNifcIncidents(geojson) {
  const features = Array.isArray(geojson?.features) ? geojson.features : [];
  const out = [];
  for (const f of features) {
    const p = f?.properties ?? {};
    const coords =
      f?.geometry?.type === 'Point' ? f.geometry.coordinates : null;
    const ll = coords
      ? clampLatLon(Number(coords[1]), Number(coords[0]))
      : null;
    if (!ll) continue;
    const irwin = String(p.IrwinID ?? '').replace(/[{}]/g, '');
    const discovered = isFiniteNum(p.FireDiscoveryDateTime)
      ? new Date(p.FireDiscoveryDateTime).toISOString()
      : null;
    out.push({
      id: `nifc:${irwin || `oid-${p.OBJECTID ?? 'unknown'}`}`,
      kind: 'incident',
      lat: roundNum(ll.lat),
      lon: roundNum(ll.lon),
      name: String(p.IncidentName ?? '').slice(0, 240),
      type: String(p.IncidentTypeCategory ?? ''),
      sizeAcres: finiteOrNull(p.IncidentSize, 1),
      discoveryTime: discovered,
      percentContained: finiteOrNull(p.PercentContained, 1),
      state: String(p.POOState ?? ''),
      county: String(p.POOCounty ?? ''),
      cause: String(p.FireCause ?? ''),
      complexity: String(p.FireMgmtComplexity ?? ''),
      gacc: String(p.GACC ?? ''),
      sources: ['nifc'],
    });
  }
  return out;
}

// ——— source fetchers ———

async function fetchHmsSource() {
  const started = Date.now();
  try {
    const { data: text, headers } = await fetchCapped(
      'hms',
      HMS_URL,
      'text',
      'text/plain',
    );
    const parsed = dedupeHmsDetections(parseHmsText(text)).slice(
      0,
      MAX_HMS_DETECTIONS,
    );
    const bySatellite = {};
    for (const d of parsed)
      bySatellite[d.satellite] = (bySatellite[d.satellite] ?? 0) + 1;
    const fileLastModified = headers?.get?.('last-modified') ?? null;
    const vintages = new Set(parsed.map((d) => d.yearDay).filter(Boolean));
    const dataVintage = vintages.size === 1 ? [...vintages][0] : null;
    const lmMs = fileLastModified ? Date.parse(fileLastModified) : NaN;
    const staleNote =
      Number.isFinite(lmMs) && Date.now() - lmMs > 7 * 86_400_000
        ? `upstream "latest" file frozen since ${fileLastModified}; detections are NOT current`
        : null;
    return {
      key: 'hms',
      ok: true,
      count: parsed.length,
      attribution: 'NOAA/NESDIS Hazard Mapping System (public domain)',
      latencyMs: Date.now() - started,
      fileLastModified,
      dataVintage,
      ...(staleNote ? { staleNote } : {}),
      detectionsBySatellite: bySatellite,
      fires: parsed,
    };
  } catch (error) {
    return {
      key: 'hms',
      ok: false,
      count: 0,
      attribution: 'NOAA/NESDIS Hazard Mapping System (public domain)',
      latencyMs: Date.now() - started,
      error: error?.message ?? 'unknown',
      fires: [],
    };
  }
}

async function fetchNifcSource() {
  const started = Date.now();
  const meta = {
    key: 'nifc',
    ok: false,
    count: 0,
    attribution: 'National Interagency Fire Center (US gov, public)',
    latencyMs: 0,
    error: 'unknown',
    fires: [],
  };
  try {
    const { data: dcat } = await fetchCapped(
      'nifc',
      NIFC_DCAT_URL,
      'json',
      'application/json',
    );
    const discovered = discoverNifcIncidentService(dcat);
    if (!discovered)
      throw Object.assign(
        new Error('fires_nifc_no_incident_service_discovered'),
        { status: 502 },
      );
    meta.discoveredDataset = discovered.title;
    meta.discoveredService = discovered.serviceUrl;
    const { data: geojson } = await fetchCapped(
      'nifc',
      buildNifcQueryUrl(discovered.serviceUrl),
      'json',
      'application/geo+json',
    );
    meta.ok = true;
    meta.fires = parseNifcIncidents(geojson).slice(0, MAX_NIFC_INCIDENTS);
    meta.count = meta.fires.length;
    delete meta.error;
  } catch (error) {
    meta.error = error?.message ?? 'unknown';
  }
  meta.latencyMs = Date.now() - started;
  return meta;
}

function buildSnapshot(results) {
  const sources = {};
  const fires = [];
  for (const r of results) {
    sources[r.key] = {
      ok: r.ok,
      count: r.count,
      attribution: r.attribution,
      latencyMs: r.latencyMs,
      ...(r.ok ? {} : { error: r.error }),
      ...(r.key === 'hms' && r.ok
        ? {
            fileLastModified: r.fileLastModified ?? null,
            dataVintage: r.dataVintage ?? null,
            ...(r.staleNote ? { staleNote: r.staleNote } : {}),
            detectionsBySatellite: r.detectionsBySatellite ?? {},
          }
        : {}),
      ...(r.key === 'nifc' && r.ok
        ? {
            discoveredDataset: r.discoveredDataset,
            discoveredService: r.discoveredService,
          }
        : {}),
    };
    fires.push(...r.fires);
  }
  // Incidents (named, authoritative) first, detections after; incidents sorted newest-first.
  fires.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'incident' ? -1 : 1;
    return String(b.discoveryTime ?? b.date ?? '').localeCompare(
      String(a.discoveryTime ?? a.date ?? ''),
    );
  });
  return {
    generatedAt: new Date().toISOString(),
    sources,
    count: fires.length,
    counts: {
      incidents: fires.filter((f) => f.kind === 'incident').length,
      detections: fires.filter((f) => f.kind === 'detection').length,
    },
    fires,
  };
}

async function getSnapshot() {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.payload;
  if (!inflight) {
    inflight = Promise.all([fetchHmsSource(), fetchNifcSource()])
      .then((results) => {
        if (!results.some((r) => r.ok)) {
          const detail = results.map((r) => `${r.key}:${r.error}`).join('; ');
          throw Object.assign(new Error(`fires_all_upstream_down: ${detail}`), {
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

function sendJson(res, status, body, cacheControl = 'public, max-age=900') {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': cacheControl,
  });
  res.end(JSON.stringify(body));
}

/** Mount the wave-6 wildfire aggregation proxy. Mirrors the wave5 quakes provider shape. */
export function firesProxy() {
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
          error: 'fires_unavailable',
          detail: error?.message ?? 'unknown',
        },
        'no-store',
      );
    }
  }

  return {
    name: 'fires',
    configureServer({ middlewares }) {
      middlewares.use('/api/fires', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/fires', handler);
    },
  };
}

export const _firesInternals = {
  parseHmsText,
  dedupeHmsDetections,
  yearDayToIso,
  discoverNifcIncidentService,
  buildNifcQueryUrl,
  parseNifcIncidents,
  buildSnapshot,
  clearCaches: () => {
    cache = null;
    inflight = null;
  },
};
