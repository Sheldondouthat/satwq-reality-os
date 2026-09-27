# F5 — NOAA OVATION Aurora · Integration Guide

**What it is:** aurora painted from the **real OVATION model grid** —
`https://services.swpc.noaa.gov/json/ovation_aurora_latest.json` — rendered
as a canvas texture over the whole globe (`Cesium.SingleTileImageryProvider`),
masked to the night side with the shared solar ephemeris. Replaces/augments
the existing Kp-index model oval with observed model data.

**OVATION endpoint verification (2026-09-27, curl):**

```
$ curl -s https://services.swpc.noaa.gov/json/ovation_aurora_latest.json | head -c 400
{"Observation Time": "2026-09-27T03:34:00Z", "Forecast Time": "2026-09-27T04:35:00Z",
 "Data Format": "[Longitude, Latitude, Aurora]", "coordinates": [[0, -90, 3], ...
```

- HTTP 200, `Access-Control-Allow-Origin: *` (keyless browser fetch OK).
- Grid: **65,160 cells** — lon 0–359 × lat −90–90 at 1° resolution.
- Values observed 0–28 (scale ~0–100); color ramp saturates at 30 ("High (30+)").
- **No fallback was needed** — the real OVATION JSON exists and is live.

**Files (all new, nothing existing was touched):**

| File | Role |
|---|---|
| `src/layers/auroraOvation/model.js` | Pure: grid parsing/validation, green→yellow→red ramp, night mask, canvas-order RGBA buffer, legend stops |
| `src/layers/auroraOvation/source.js` | SWPC fetch source (injectable fetch); throws on malformed payloads |
| `src/layers/auroraOvation/index.js` | `createAuroraOvationLayer()` + `createOvationLegend()` HUD legend DOM |
| `src/layers/auroraOvation/auroraOvation.test.mjs` | Unit tests with inline fixture mirroring the real payload |

## Wiring (integrator: add to the layer registry / main bootstrap)

```js
import { createAuroraOvationLayer, createOvationLegend } from './layers/auroraOvation/index.js';

const ovation = createAuroraOvationLayer({ overlayHost }); // overlayHost optional
ovation.init(viewer);
registerLayer(ovation);
// HUD toggle wiring:
let legend = null;
hudToggle('aurora-ovation', (on) => {
  if (on) { ovation.enable(viewer); legend = createOvationLegend(ovation, { mount: viewerContainer }); }
  else { legend?.destroy(); legend = null; ovation.disable(viewer); }
});
// after each update (or on a 60 s timer): legend?.sync();
```

> The existing Kp-oval `aurora` layer is untouched — register OVATION
> alongside it or in place of it; they use different layer ids
> (`aurora` vs `aurora-ovation`) and different overlay source ids, so they
> coexist without collision.

## Rendering details

- 360×181 canvas → `putImageData` → `toDataURL('image/png')` →
  `SingleTileImageryProvider` over `Rectangle(-180,-90,180,90)`, alpha 0.9.
  Refresh replaces the single provider (no tile pyramid, one small texture).
- **Night mask:** subsolar point from `../terminator/model.js` (read-only
  import, pure math) at the grid's *observation* time. Cells on the day side
  are dimmed to 8% alpha (data extent stays visible); a 6° twilight margin
  softens the day edge.
- `updateInterval` 5 min (SWPC refreshes the grid every few minutes).
- **Failure mode:** fetch/parse errors keep the last good frame on screen and
  set `getStats().error`. The layer never renders synthetic aurora.

## Legend

`createOvationLegend(layer, { mount })` builds an inline-styled HUD card:
gradient bar (green→yellow→orange→red), tick labels `1 8 15 22 30+`,
"intensity 0–30+ · night side", and the live observation timestamp
(`legend.sync()` refreshes it). `legend.destroy()` removes it.

## Analyst / stats API

```js
ovation.getStats();
// { count, cells:65160, observationTimeMs, forecastTimeMs, lastUpdate, error }
ovation.getAnalystRecords();
// [{ id, type:'aurora-ovation', observationTimeMs, forecastTimeMs, cells }]
```

## Behavior notes

- **Keys:** none. SWPC serves the JSON with CORS `*`.
- Data cadence: observation time in the payload is typically minutes old;
  the legend surfaces it so staleness is visible, never hidden.
