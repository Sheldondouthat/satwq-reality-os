# F3 — Seismic Wavefronts · Integration Guide

**What it is:** live P-wave (~8 km/s) and S-wave (~4.5 km/s) expanding rings
from the 8 most recent mag-4.5+ quakes, rendered as Cesium ellipses whose
radii are `CallbackProperty`s driven by each quake's origin epoch — the
fronts grow smoothly on the globe with no per-frame re-render. Rings fade
with age and auto-expire after 30 minutes. Toggleable like other overlays.

**Files (all new, nothing existing was touched):**

| File | Role |
|---|---|
| `src/layers/seismicWaves/model.js` | Pure math: `wavefrontRadii(originMs, nowMs)`, expiry, alpha fade, USGS feature normalization, top-N picking |
| `src/layers/seismicWaves/source.js` | USGS `4.5_day.geojson` snapshot source (injectable fetch, keyless) |
| `src/layers/seismicWaves/index.js` | `createSeismicWavesLayer()` — CustomDataSource + ellipse entities + epicenter markers |
| `src/layers/seismicWaves/seismicWaves.test.mjs` | Unit tests (frozen clock) |

## Wiring (integrator: add to the layer registry / main bootstrap)

```js
import { createSeismicWavesLayer } from './layers/seismicWaves/index.js';

const waves = createSeismicWavesLayer({ overlayHost }); // overlayHost optional
waves.init(viewer);
registerLayer(waves);
// HUD toggle wiring:
hudToggle('seismic-waves', (on) => on ? waves.enable(viewer) : waves.disable(viewer));
```

## Rendering details

- Per quake: 1 epicenter point (size scales with magnitude) + label
  (`M5.2 place`) + 2 ellipse outlines — **cyan = P front, orange = S front**.
- Ring radius = `waveSpeed × (now − originTime)`, capped at 20,015 km
  (half Earth's circumference). At 30 min the P front is at 14,400 km, so the
  cap never visually triggers before expiry.
- Opacity fades 0.95 → 0.06 over the 30-minute life.
- `updateInterval` 30 s: refetches USGS, re-picks the top 8, rebuilds entities,
  drops expired quakes. Between sweeps, radii keep growing via
  `CallbackProperty` — no polling needed for smooth motion.
- **Failure mode:** on fetch error the layer keeps the already-drawn rings
  (they keep growing and will expire normally) and reports the error in
  `getStats().error`. No fake rings are ever synthesized.

## Analyst / stats API

```js
waves.getStats();
// { count, lastUpdate, error, quakes:[{id, mag}] }
waves.getAnalystRecords();
// [{ id, type:'seismic-wavefront', mag, place, originTimeMs, ageSec, pKm, sKm }]
```

## Behavior notes

- **Keys:** none. Same `earthquake.usgs.gov` host the existing earthquakes
  layer already fetches from in-browser.
- **Degradation:** if ellipse rendering ever proves unworkable, the honest
  fallback is epicenter markers only — the `sw:{id}:epi` point entities
  already exist independently of the rings.
- Entity ids: `sw:{quakeId}:epi`, `sw:{q}:p`, `sw:{q}:s` — safe to query or
  style from the HUD.
