/**
 * VAAC ash × aviation crosshair — model. Wave 3 (1.8).
 *
 * Pure logic (no Cesium, no DOM): fetch /api/vaac-polygons, flatten advisory
 * volumes (observation + forecasts) into renderable records, and cross ash
 * volumes with aircraft tracks (altitude-aware: FL→ft).
 */

const API_URL = '/api/vaac-polygons';
const MIL_AIRCRAFT_URL = '/api/adsblol/mil';
export const FT_PER_FL = 100;

export async function fetchVaacPolygons({ fetchImpl, signal } = {}) {
  const f = fetchImpl || fetch;
  const response = await f(API_URL, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`vaacpoly_http_${response.status}`);
  const body = await response.json();
  if (!Array.isArray(body?.advisories)) throw new Error('vaacpoly_bad_shape');
  return body;
}

/** Flatten advisories → volume records with absolute time + kind. */
export function flattenAshVolumes(advisories) {
  const out = [];
  for (const a of advisories ?? []) {
    const obs = a?.observation;
    if (obs && Array.isArray(obs.volumes)) {
      for (const v of obs.volumes) {
        out.push({
          volcano: a.volcano,
          advisoryNumber: a.advisoryNumber,
          issueTime: a.issueTime,
          kind: 'observation',
          time: obs.time,
          status: obs.status,
          upperFt: v.upperFl != null ? v.upperFl * FT_PER_FL : null,
          lowerFt:
            v.lowerFl != null
              ? v.lowerFl * FT_PER_FL
              : v.lowerGround
                ? 0
                : null,
          rings: v.rings,
        });
      }
    }
    for (const fc of a?.forecasts ?? []) {
      for (const v of fc?.volumes ?? []) {
        out.push({
          volcano: a.volcano,
          advisoryNumber: a.advisoryNumber,
          issueTime: a.issueTime,
          kind: 'forecast',
          time: fc.time,
          status: null,
          upperFt: v.upperFl != null ? v.upperFl * FT_PER_FL : null,
          lowerFt:
            v.lowerFl != null
              ? v.lowerFl * FT_PER_FL
              : v.lowerGround
                ? 0
                : null,
          rings: v.rings,
        });
      }
    }
  }
  return out;
}

/** Ray-casting point-in-ring for [lon,lat] rings. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Cross ash volumes with aircraft tracks.
 * aircraft: [{id, lon, lat, altFt}] → [{aircraft, volume}] where the aircraft
 * is horizontally inside the volume AND vertically within its FL band
 * (missing altitude ⇒ horizontal match only, flagged as altUnknown).
 */
export function crossAshWithAircraft(volumes, aircraft) {
  const hits = [];
  for (const ac of aircraft ?? []) {
    if (!Number.isFinite(ac?.lon) || !Number.isFinite(ac?.lat)) continue;
    for (const vol of volumes ?? []) {
      if (!Array.isArray(vol.rings)) continue;
      const inside = vol.rings.some((ring) =>
        pointInRing(ac.lon, ac.lat, ring),
      );
      if (!inside) continue;
      const altOk =
        !Number.isFinite(ac.altFt) ||
        ((vol.lowerFt == null || ac.altFt >= vol.lowerFt) &&
          (vol.upperFt == null || ac.altFt <= vol.upperFt));
      if (altOk) {
        hits.push({
          aircraft: ac,
          volume: vol,
          altUnknown: !Number.isFinite(ac.altFt),
        });
      }
    }
  }
  return hits;
}

/** Fetch military aircraft from the keyless adsb.lol mil proxy. */
export async function fetchMilAircraft({ fetchImpl, signal } = {}) {
  const f = fetchImpl || fetch;
  const response = await f(MIL_AIRCRAFT_URL, { signal, cache: 'no-store' });
  if (!response.ok) throw new Error(`adsblol_mil_${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.ac) ? body.ac : [])
    .filter((a) => Number.isFinite(a?.lon) && Number.isFinite(a?.lat))
    .map((a) => ({
      id: String(a.hex ?? a.flight ?? 'unknown').trim(),
      lon: a.lon,
      lat: a.lat,
      altFt: Number.isFinite(a.alt_baro) ? a.alt_baro : null,
    }));
}
