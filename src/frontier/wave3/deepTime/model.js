/**
 * Deep-time mode (wave3 sci-fi B #1) — paleogeography model.
 *
 * Pure, DOM-free helpers: age-slice selection, honesty labeling, and slice
 * validation. All rendering lives in index.js.
 *
 * Physics honesty: these coastlines are the OUTPUT of a plate-kinematic
 * MODEL (Zahirovic et al. 2022 via the GPlates Web Service), not observations
 * of the past. Positional uncertainty grows with age and is severe beyond
 * ~150 Ma; pre-200 Ma shapes are illustrative, not authoritative.
 */

export const DEEP_TIME_MODEL = 'ZAHIROVIC2022';
export const DEEP_TIME_MODEL_FULL =
  'Zahirovic et al. (2022) plate model, served by the GPlates Web Service';
export const DEEP_TIME_SOURCE_URL = 'https://gws.gplates.org/reconstruct/coastlines/';
export const DEEP_TIME_RETRIEVED = '2026-09-27';

/** Age slices bundled with the app (million years before present). */
export const AGE_SLICES_MA = [0, 50, 100, 150, 200, 250, 300];

export const DEEP_TIME_HONESTY =
  'Model reconstruction, not observation. Coastlines are the output of the ' +
  DEEP_TIME_MODEL +
  ' plate-kinematic model (GPlates Web Service, retrieved ' +
  DEEP_TIME_RETRIEVED +
  '). Uncertainty grows with age: post-100 Ma is reasonably constrained, ' +
  '150–200 Ma is approximate, and pre-200 Ma shapes are illustrative. ' +
  'Slice set is coarse (50 Myr steps); interpolation between slices is not shown.';

/** Human label for an age in millions of years. */
export function ageLabel(ageMa) {
  const a = Number(ageMa);
  if (!Number.isFinite(a) || a < 0) throw new TypeError('ageMa must be a non-negative number');
  if (a === 0) return 'Present day';
  return `${a} million years ago`;
}

/** Nearest bundled slice to a requested age. */
export function nearestSliceAge(ageMa) {
  const a = Number(ageMa);
  if (!Number.isFinite(a)) throw new TypeError('ageMa must be a number');
  let best = AGE_SLICES_MA[0];
  for (const s of AGE_SLICES_MA) {
    if (Math.abs(s - a) < Math.abs(best - a)) best = s;
  }
  return best;
}

/** Loader key → dynamic-import mapping lives in index.js; this names the file. */
export function sliceAssetName(ageMa) {
  return `deep_coast_${nearestSliceAge(ageMa)}Ma.json`;
}

/**
 * Validate a bundled slice document. Compact schema: { ageMa, model,
 * source, features: [{t:'P'|'M', c: rings}] } where a ring is [lon,lat][].
 */
export function validateSlice(doc) {
  if (!doc || typeof doc !== 'object') return { ok: false, reason: 'not an object' };
  if (!AGE_SLICES_MA.includes(doc.ageMa)) {
    return { ok: false, reason: `unexpected ageMa ${doc.ageMa}` };
  }
  if (doc.model !== DEEP_TIME_MODEL) {
    return { ok: false, reason: `unexpected model ${doc.model}` };
  }
  if (!Array.isArray(doc.features) || doc.features.length === 0) {
    return { ok: false, reason: 'features missing or empty' };
  }
  for (let i = 0; i < doc.features.length; i += 1) {
    const f = doc.features[i];
    if (f?.t !== 'P' && f?.t !== 'M') return { ok: false, reason: `feature ${i} bad type` };
    const rings = f.t === 'P' ? f.c : f.c.flat();
    if (!Array.isArray(rings) || rings.length === 0) {
      return { ok: false, reason: `feature ${i} has no rings` };
    }
    for (const ring of rings) {
      if (!Array.isArray(ring) || ring.length < 4) {
        return { ok: false, reason: `feature ${i} ring too short` };
      }
      for (const [lon, lat] of ring) {
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
          return { ok: false, reason: `feature ${i} has non-finite coordinate` };
        }
        if (Math.abs(lon) > 180 || Math.abs(lat) > 90) {
          return { ok: false, reason: `feature ${i} coordinate out of range` };
        }
      }
    }
  }
  return { ok: true, reason: null };
}

/** Total rendered vertex count — used to keep the globe load sane. */
export function countSliceVertices(doc) {
  let n = 0;
  for (const f of doc.features ?? []) {
    const rings = f.t === 'P' ? f.c : f.c.flat();
    for (const ring of rings) n += ring.length;
  }
  return n;
}
