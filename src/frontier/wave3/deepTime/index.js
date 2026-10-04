/**
 * Deep-time mode (wave3 sci-fi B #1) — GPlates paleogeography scrubber.
 *
 * Scrub 0–300 Ma and watch reconstructed coastlines drift from Pangea to the
 * present. Slices are pre-bundled static assets, lazy-loaded via dynamic
 * import so the main bundle stays light.
 *
 * init(viewer, { mount }) → { destroy } — fail-soft: any failure leaves the
 * host app untouched. Honesty caption is always rendered alongside the
 * slider (see model.js DEEP_TIME_HONESTY).
 */
import * as Cesium from 'cesium';
import {
  AGE_SLICES_MA,
  DEEP_TIME_HONESTY,
  DEEP_TIME_MODEL_FULL,
  ageLabel,
  nearestSliceAge,
  sliceAssetName,
  validateSlice,
} from './model.js';

// Static dynamic-import map so Vite emits one lazy chunk per slice.
const SLICE_LOADERS = {
  0: () => import('./data/deep_coast_0Ma.json'),
  50: () => import('./data/deep_coast_50Ma.json'),
  100: () => import('./data/deep_coast_100Ma.json'),
  150: () => import('./data/deep_coast_150Ma.json'),
  200: () => import('./data/deep_coast_200Ma.json'),
  250: () => import('./data/deep_coast_250Ma.json'),
  300: () => import('./data/deep_coast_300Ma.json'),
};

const MAX_POLY_VERTICES = 400;

function ringToHierarchy(ring) {
  const pts = ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat));
  return new Cesium.PolygonHierarchy(pts);
}

/** Simplify a ring for rendering (stride decimation, closed). */
function thinRing(ring) {
  if (ring.length <= MAX_POLY_VERTICES) return ring;
  const stride = Math.ceil(ring.length / MAX_POLY_VERTICES);
  const out = ring.filter((_, i) => i % stride === 0);
  const last = ring[ring.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function init(viewer, { mount = null } = {}) {
  if (!viewer || typeof document === 'undefined') return null;
  const entities = viewer.entities;
  const owned = [];
  const cache = new Map(); // sliceAge -> validated doc
  let currentSlice = null;
  let destroyed = false;
  let requestToken = 0;

  function clearPolygons() {
    for (const e of owned.splice(0)) {
      try {
        entities.remove(e);
      } catch {
        /* best effort */
      }
    }
    currentSlice = null;
  }

  async function loadSlice(ageMa) {
    if (cache.has(ageMa)) return cache.get(ageMa);
    const mod = await SLICE_LOADERS[ageMa]();
    const doc = mod?.default ?? mod;
    const check = validateSlice(doc);
    if (!check.ok)
      throw new Error(`invalid deep-time slice ${ageMa}Ma: ${check.reason}`);
    cache.set(ageMa, doc);
    return doc;
  }

  function renderSlice(ageMa, doc) {
    clearPolygons();
    const land = Cesium.Color.fromCssColorString('#2b6cb0').withAlpha(0.85);
    for (const f of doc.features) {
      const polys = f.t === 'P' ? [f.c] : f.c;
      for (const rings of polys) {
        if (!rings.length) continue;
        const outer = thinRing(rings[0]);
        try {
          owned.push(
            entities.add({
              polygon: {
                hierarchy: ringToHierarchy(outer),
                material: land,
                height: 0,
                outline: true,
                outlineColor:
                  Cesium.Color.fromCssColorString('#9fc2ff').withAlpha(0.5),
              },
            }),
          );
        } catch {
          /* one bad polygon never kills the render */
        }
      }
    }
    currentSlice = ageMa;
    caption.textContent = `${ageLabel(ageMa)} — ${doc.features.length} landmasses (${DEEP_TIME_MODEL_FULL})`;
  }

  async function showAge(ageMa) {
    const slice = nearestSliceAge(ageMa);
    if (slice === currentSlice) return;
    const token = ++requestToken;
    slider.value = String(ageMa);
    label.textContent = ageLabel(slice);
    try {
      const doc = await loadSlice(slice);
      if (destroyed || token !== requestToken) return;
      renderSlice(slice, doc);
    } catch (error) {
      if (destroyed || token !== requestToken) return;
      caption.textContent = `Slice ${sliceMa(slice)} unavailable: ${error?.message ?? error}`;
      console.warn('[deepTime]', error);
    }
  }

  function sliceMa(s) {
    return `${s} Ma`;
  }

  // — UI —
  const panel = document.createElement('div');
  panel.style.cssText =
    'margin-top:8px;padding:8px;border-radius:8px;background:rgba(10,18,32,.7);' +
    'border:1px solid rgba(120,180,255,.2);';
  const title = document.createElement('div');
  title.style.cssText =
    'font-size:10px;letter-spacing:.12em;color:#8aa4d6;font-weight:600;';
  title.textContent = '⏳ DEEP TIME';
  const label = document.createElement('div');
  label.style.cssText = 'color:#dfe9ff;font-size:12px;margin:4px 0;';
  label.textContent = ageLabel(0);
  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = '0';
  slider.max = '300';
  slider.step = '10';
  slider.value = '0';
  slider.setAttribute('aria-label', 'Millions of years before present');
  slider.style.cssText = 'width:100%;';
  const caption = document.createElement('div');
  caption.style.cssText =
    'color:#9fb4dd;font-size:10px;margin-top:2px;min-height:24px;';
  caption.textContent = ageLabel(0);
  const honesty = document.createElement('div');
  honesty.style.cssText =
    'color:#7d8fb5;font-size:9px;margin-top:4px;line-height:1.4;';
  honesty.textContent = DEEP_TIME_HONESTY;

  let debounce = null;
  slider.addEventListener('input', () => {
    label.textContent = `${slider.value} Ma — nearest slice ${nearestSliceAge(Number(slider.value))} Ma`;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => showAge(Number(slider.value)), 220);
  });

  panel.append(title, label, slider, caption, honesty);
  (mount ?? document.body).appendChild(panel);

  // Render present-day slice on first mount (lazy, async).
  showAge(0);

  return {
    showAge,
    getCurrentSlice: () => currentSlice,
    destroy() {
      destroyed = true;
      requestToken += 1;
      if (debounce) clearTimeout(debounce);
      clearPolygons();
      panel.remove();
    },
  };
}

export {
  AGE_SLICES_MA,
  DEEP_TIME_HONESTY,
  sliceAssetName,
  nearestSliceAge,
  ageLabel,
};
