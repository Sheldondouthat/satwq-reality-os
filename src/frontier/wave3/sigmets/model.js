/**
 * SIGMETs + airport weather — pure data logic (no Cesium, testable in plain Node).
 *
 * Consumes the trimmed /api/sigmets snapshot:
 *   {generatedAt, count, sigmets:[{icaoId,firId,firName,hazard,qualifier,
 *    severity,base,top,validFrom,validTo,dir,spd,chng,geom,coords,rawSigmet}]}
 * and /api/airports/metar?ids=…:
 *   {generatedAt, reports:[{icaoId,obsTime,temp,dewp,wdir,wspd,wgst,visib,
 *    fltcat,cover,lat,lon,name,rawOb}]}
 */

export const HAZARD_LABELS = {
  TS: 'Thunderstorm',
  TURB: 'Turbulence',
  ICE: 'Icing',
  MTW: 'Mountain wave',
  VA: 'Volcanic ash',
  DS: 'Dust storm',
  SS: 'Sandstorm',
  TC: 'Tropical cyclone',
  RDOACT: 'Radioactive cloud',
};

export const HAZARD_COLORS = {
  TS: { r: 0.75, g: 0.25, b: 1.0, a: 0.4 },
  TURB: { r: 1.0, g: 0.55, b: 0.1, a: 0.4 },
  ICE: { r: 0.3, g: 0.7, b: 1.0, a: 0.4 },
  MTW: { r: 0.6, g: 0.45, b: 0.3, a: 0.4 },
  VA: { r: 0.55, g: 0.1, b: 0.1, a: 0.5 },
  DS: { r: 0.85, g: 0.7, b: 0.45, a: 0.35 },
  SS: { r: 0.85, g: 0.65, b: 0.35, a: 0.35 },
  TC: { r: 1.0, g: 0.2, b: 0.5, a: 0.45 },
  RDOACT: { r: 0.4, g: 1.0, b: 0.4, a: 0.45 },
};

const DEFAULT_COLOR = { r: 0.65, g: 0.7, b: 0.85, a: 0.35 };

export function hazardLabel(hazard) {
  return HAZARD_LABELS[hazard] ?? (hazard ? `SIGMET ${hazard}` : 'SIGMET');
}

export function colorForSigmet(sigmet) {
  return HAZARD_COLORS[sigmet?.hazard] ?? DEFAULT_COLOR;
}

export function altitudeRange(sigmet) {
  const topFt = Number.isFinite(sigmet?.top) ? sigmet.top : null;
  const baseFt = Number.isFinite(sigmet?.base) ? sigmet.base : 0;
  return { baseFt, topFt };
}

export function sigmetExpired(sigmet, nowMs = Date.now()) {
  const validTo = Number(sigmet?.validTo);
  return Number.isFinite(validTo) ? validTo * 1000 < nowMs : false;
}

/** Ring positions as [lon, lat] pairs, closed. */
export function sigmetRing(sigmet) {
  const coords = Array.isArray(sigmet?.coords) ? sigmet.coords : [];
  return coords
    .map((c) => [c?.lon, c?.lat])
    .filter(([lon, lat]) => Number.isFinite(lon) && Number.isFinite(lat));
}

export async function fetchSigmets({ fetchImpl = fetch } = {}) {
  const response = await fetchImpl('/api/sigmets', { cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`sigmets_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function fetchAirportReports({
  kind = 'metar',
  ids = [],
  fetchImpl = fetch,
} = {}) {
  if (!ids.length) return { reports: [] };
  const response = await fetchImpl(
    `/api/airports/${kind}?ids=${ids.join(',')}`,
    { cache: 'no-store' },
  );
  if (!response.ok) {
    const error = new Error(`airports_${kind}_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export const FLTCAT_COLORS = {
  VFR: { r: 0.25, g: 0.9, b: 0.35 },
  MVFR: { r: 0.35, g: 0.6, b: 1.0 },
  IFR: { r: 1.0, g: 0.35, b: 0.25 },
  LIFR: { r: 0.75, g: 0.3, b: 1.0 },
};

export function colorForFlightCategory(fltcat) {
  return (
    FLTCAT_COLORS[String(fltcat ?? '').toUpperCase()] ?? {
      r: 0.6,
      g: 0.65,
      b: 0.7,
    }
  );
}

/** Curated major-airport dot set (one METAR call, ≤20 stations). */
export const AIRPORT_DOT_STATIONS = [
  'KJFK',
  'KEWR',
  'KBOS',
  'KIAD',
  'KATL',
  'KMIA',
  'KORD',
  'KDFW',
  'KDEN',
  'KSEA',
  'KSFO',
  'KLAX',
  'KPHX',
  'KLAS',
  'KMSP',
  'KDTW',
  'KCLT',
  'KIAH',
  'KSLC',
  'KPHL',
];
