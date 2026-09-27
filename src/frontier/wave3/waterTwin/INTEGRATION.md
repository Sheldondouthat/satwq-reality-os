# INTEGRATION.md — 1.10 Water twin (`wave3/waterTwin`)

Feature dir: `src/frontier/wave3/waterTwin/` · Provider: `server/providers/wave3/waterTwin.js`
Tests: `src/frontier/wave3/waterTwin/waterTwin.test.mjs` (7) + `server/providers/wave3/waterTwin.test.mjs` (8) — all passing.
Live verifications (2026-09-27): CDEC daily storage CSV for SHA
(`Shasta Lake → 2,477,120 AF`, sensor 15 = STORAGE); USGS NWIS IV
`07010000` → flow 273000 cfs / gage 16.09 ft. NWIS reservoir *storage* is
not live for the big reservoirs (probed IV + DV, all empty) — so the
reservoir leg uses CDEC, and the registry documents the split.

**Collision note (worker W4, item 2.1 gauge layer):** this provider owns the
RESERVOIR/flood-state COUPLING only — per-site flood BANDS + reservoir %
capacity. It never exposes a generic gauge layer. Shared registry at
`src/frontier/wave3/waterTwin/registry.js` (imported by the provider);
W4's gauge layer should not re-read NWIS IV for the same river sites unless
it needs the raw layer, in which case it uses its own files.

## 1. Exact lines for `server/providers/local.js`

Add to the import block (after the dart import line):

```js
import { waterTwinProxy } from './wave3/waterTwin.js';
```

Add to the `localProviderPlugins()` array (after `dartCouplingProxy(),`):

```js
    waterTwinProxy(),
```

Route served: `GET /api/water-twin` — reservoirs (% of capacity) + rivers
(flood-state bands). Zero keys; no WASM/node:fs.

## 2. Exact lines for `server/pages/registry.mjs`

Append to the `REGISTRY` array (after the dart-coupling entry):

```js
  {
    name: 'water-twin',
    routes: ['/api/water-twin'],
    load: () => import('../providers/wave3/waterTwin.js').then((m) => m.waterTwinProxy()),
  },
```

No exclusion: plain fetch + CSV/JSON parsing (esbuild-safe).

## 3. Exact mount call for `initFrontier` (inside the `initFrontier` body)

Add the import at the top of `src/frontier/index.js`:

```js
import { initWaterTwin } from './wave3/waterTwin/index.js';
```

Add a mount attempt (after the DART block):

```js
  // — Wave 3 · 1.10 water twin —
  attempt('water-twin', () => {
    const s = section(t('feature.waterTwin'));
    const handle = initWaterTwin({
      viewer,
      mount: (node) => s.appendChild(node),
    });
    dock.appendChild(s);
    return () => handle.destroy();
  });
```

## 4. New UI strings for theme dictionaries

```js
'feature.waterTwin': 'Water twin — reservoirs & rivers',
```

## Honesty notes for the UI copy

- Reservoir capacities (acre-ft) and river flood/action stages are CURATED
  APPROXIMATE reference figures; the UI copy states this next to the data.
- Flood "bands" are height bands vs the curated stage — NOT official NWS
  flood categories.
- Precipitation cross-composition is DONE (client-side, 2026-09-27):
  `precip.js` composes the latest live RainViewer radar frame into an XYZ
  tile template (translucent Cesium imagery layer on the globe) plus one
  pre-composed tile per registry reservoir/river, with the frame time shown
  in the panel. Verified live against the RainViewer public API on
  2026-09-27 (13 past frames; tile HTTP 200 over St. Louis at z=6). Labeled
  as observed reflectivity — never as a forecast or rain total. Fail-soft:
  radar failure degrades to a "radar unavailable" row, never blocks the twin.
