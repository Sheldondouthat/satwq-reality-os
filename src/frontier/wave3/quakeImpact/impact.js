/**
 * DYFI / ShakeMap / PAGER impact overlay (Wave 3, Track 1c, item 1.12).
 *
 * Extends the existing USGS quake path (client-side, keyless — USGS serves
 * CORS). For one quake (by event id) it pulls three impact products from the
 * ComCat detail document:
 *   - DYFI felt reports:   products.dyfi[].contents['dyfi_geo_10km.geojson']
 *   - ShakeMap MMI contours: products.shakemap[].contents['download/cont_mmi.json']
 *   - PAGER alert level:    properties.alert + products.losspager[].contents['json/alerts.json']
 *
 * Product shapes verified live 2026-09-27 on event us7000ti1p (M6.5, Alaska).
 *
 * Physics honesty: ShakeMap contours are MODELED shaking (labeled as such);
 * DYFI is felt REPORTS (crowdsourced, sparse offshore); PAGER is a modeled
 * loss estimate. The module labels each as model vs observation.
 */

const DETAIL_URL = (eventId) =>
  `https://earthquake.usgs.gov/fdsnws/event/1/query?eventid=${encodeURIComponent(eventId)}&format=geojson`;
const FEED_URL =
  'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson';
const USGS_ORIGIN = 'https://earthquake.usgs.gov';

function safeUsgsUrl(url) {
  try {
    const u = new URL(url);
    if (u.origin !== USGS_ORIGIN) return null;
    return u.toString();
  } catch {
    return null;
  }
}

function productContentUrl(products, productName, contentName) {
  const list = products?.[productName];
  if (!Array.isArray(list) || !list.length) return null;
  const contents = list[0]?.contents ?? {};
  const entry = contents[contentName];
  return entry?.url ? safeUsgsUrl(entry.url) : null;
}

/** USGS-ish MMI → color ramp (modeled shaking). */
export function mmiColor(mmi) {
  const m = Number(mmi);
  if (!Number.isFinite(m)) return '#8a93a6';
  if (m < 2) return '#80ffff';
  if (m < 3) return '#7cffc7';
  if (m < 4) return '#a7ff7c';
  if (m < 5) return '#e8ff7c';
  if (m < 6) return '#ffd27c';
  if (m < 7) return '#ff9d5c';
  if (m < 8) return '#ff5c5c';
  if (m < 9) return '#e01b1b';
  return '#a00000';
}

export const PAGER_COLORS = Object.freeze({
  green: '#4dd07a',
  yellow: '#ffd21a',
  orange: '#ff9d1a',
  red: '#ff3b3b',
});

export function pagerColor(level) {
  return PAGER_COLORS[level] ?? '#8a93a6';
}

async function fetchJson(fetchImpl, url, signal) {
  const res = await fetchImpl(url, { signal });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

/**
 * Fetch and parse the full impact bundle for one quake.
 * @returns {object} { eventId, mag, place, timeMs, lat, lon, pager, dyfi, shakemap }
 *   each product: { available, ... } — never throws for a missing product.
 */
export async function getQuakeImpact(
  eventId,
  { fetchImpl = fetch, timeoutMs = 20000 } = {},
) {
  if (!eventId || typeof eventId !== 'string')
    throw new Error('eventId required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const detail = await fetchJson(
      fetchImpl,
      DETAIL_URL(eventId),
      controller.signal,
    );
    const props = detail?.properties ?? {};
    const products = props.products ?? {};
    const coords = detail?.geometry?.coordinates ?? [];
    const impact = {
      eventId,
      mag: Number(props.mag),
      place: String(props.place ?? 'Unknown'),
      timeMs: Number(props.time),
      lat: Number(coords[1]),
      lon: Number(coords[0]),
      detailUrl: `https://earthquake.usgs.gov/earthquakes/eventpage/${eventId}`,
    };

    // — PAGER —
    const alertsUrl = productContentUrl(
      products,
      'losspager',
      'json/alerts.json',
    );
    let pagerAlerts = null;
    if (alertsUrl) {
      try {
        pagerAlerts = await fetchJson(fetchImpl, alertsUrl, controller.signal);
      } catch {}
    }
    impact.pager = {
      available: !!(props.alert || pagerAlerts),
      level: props.alert ?? pagerAlerts?.fatality?.level ?? null,
      fatality: pagerAlerts?.fatality
        ? summarizePagerBin(pagerAlerts.fatality)
        : null,
      economic: pagerAlerts?.economic
        ? summarizePagerBin(pagerAlerts.economic)
        : null,
      kind: 'model', // PAGER is a modeled loss estimate
    };

    // — DYFI felt reports —
    const dyfiUrl = productContentUrl(
      products,
      'dyfi',
      'dyfi_geo_10km.geojson',
    );
    let dyfiPoints = [];
    if (dyfiUrl) {
      try {
        const geo = await fetchJson(fetchImpl, dyfiUrl, controller.signal);
        dyfiPoints = normalizeDyfi(geo);
      } catch {}
    }
    impact.dyfi = {
      available: dyfiPoints.length > 0,
      points: dyfiPoints,
      kind: 'observation', // crowdsourced felt reports
      maxCdi: dyfiPoints.reduce((m, p) => Math.max(m, p.cdi), 0),
    };

    // — ShakeMap MMI contours —
    const mmiUrl = productContentUrl(
      products,
      'shakemap',
      'download/cont_mmi.json',
    );
    let contours = [];
    if (mmiUrl) {
      try {
        const geo = await fetchJson(fetchImpl, mmiUrl, controller.signal);
        contours = normalizeMmiContours(geo);
      } catch {}
    }
    impact.shakemap = {
      available: contours.length > 0,
      contours,
      kind: 'model', // modeled shaking intensity
    };

    return impact;
  } finally {
    clearTimeout(timer);
  }
}

function summarizePagerBin(bin) {
  return {
    level: bin.level ?? null,
    gvalue: Number.isFinite(Number(bin.gvalue)) ? Number(bin.gvalue) : null,
    units: bin.units ?? null,
    topBin: Array.isArray(bin.bins)
      ? (bin.bins[bin.bins.length - 1]?.color ?? null)
      : null,
  };
}

/** DYFI 10km grid: Polygon cells with {cdi, nresp, name, dist}. */
export function normalizeDyfi(geojson) {
  const out = [];
  for (const f of geojson?.features ?? []) {
    const p = f?.properties ?? {};
    const cdi = Number(p.cdi);
    if (!Number.isFinite(cdi)) continue;
    const ring = f?.geometry?.coordinates?.[0];
    if (!Array.isArray(ring) || !ring.length) continue;
    let lon = 0,
      lat = 0;
    for (const [lo, la] of ring) {
      lon += lo;
      lat += la;
    }
    out.push({
      lon: lon / ring.length,
      lat: lat / ring.length,
      cdi,
      nresp: Number(p.nresp) || 0,
      name: typeof p.name === 'string' ? p.name.replace(/<br>/g, ' ') : null,
    });
  }
  return out;
}

/** ShakeMap cont_mmi.json: features with properties {value (MMI), color}. */
export function normalizeMmiContours(geojson) {
  const out = [];
  for (const f of geojson?.features ?? []) {
    const p = f?.properties ?? {};
    const mmi = Number(p.value);
    if (!Number.isFinite(mmi)) continue;
    const geom = f?.geometry;
    // Polygon: coordinates = [ring, ...]; MultiPolygon: [[ring, ...], ...].
    const polys =
      geom?.type === 'MultiPolygon'
        ? (geom.coordinates ?? []).flat()
        : geom?.coordinates;
    if (!Array.isArray(polys)) continue;
    const rings = polys.filter(
      (r) =>
        Array.isArray(r) &&
        r.length >= 4 &&
        Array.isArray(r[0]) &&
        Number.isFinite(Number(r[0][0])),
    );
    out.push({
      mmi,
      color: typeof p.color === 'string' ? p.color : mmiColor(mmi),
      rings,
    });
  }
  return out.sort((a, b) => a.mmi - b.mmi);
}

/** Pick the largest quake in the recent feed (for the "latest big quake" button). */
export async function findLargestRecentQuake({
  fetchImpl = fetch,
  minMag = 5.5,
  timeoutMs = 15000,
} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const payload = await fetchJson(fetchImpl, FEED_URL, controller.signal);
    let best = null;
    for (const f of payload?.features ?? []) {
      const mag = Number(f?.properties?.mag);
      if (!Number.isFinite(mag) || mag < minMag) continue;
      if (!best || mag > best.mag) {
        best = {
          eventId:
            String(f?.properties?.ids ?? '')
              .split(',')
              .filter(Boolean)
              .find((s) => s.startsWith('us')) ?? String(f.id ?? ''),
          mag,
          place: f?.properties?.place,
        };
      }
    }
    return best;
  } finally {
    clearTimeout(timer);
  }
}
