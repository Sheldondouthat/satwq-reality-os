# INTEGRATION — Wave 3 1.6 satellite visibility oracle

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

No changes. The oracle is provider-free by design: it reuses the existing
`/api/celestrak/*` pipeline (stations, visual, starlink groups) and computes
SGP4 passes client-side. No new route, no new upstream, no new cache.

## 2. server/pages/registry.mjs

Documented exclusion: there is nothing to register — the oracle consumes the
already-registered `/api/celestrak/*` routes and adds no provider file under
`server/providers/`. Nothing to port, nothing to exclude.

## 3. src/frontier/index.js

Add the import at the top (with the other wave3 feature imports):

```js
import { initSatOracle, mountSatOracleDock } from './wave3/satOracle/index.js';
```

Add the mount inside `initFrontier`, after the TFR block:

```js
  // — W3.6 satellite visibility oracle —
  attempt('sat-oracle', () => {
    const oracle = initSatOracle({ viewer });
    if (!oracle) return;
    trackLayer('satOracle', oracle);
    const dockCtl = mountSatOracleDock({ section, chip, t, oracle });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); oracle.destroy(); };
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js`:

```js
  'feature.satOracle',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.satOracle': 'Satellite visibility oracle',
```

## Files owned by this feature (do not move)

- `src/frontier/wave3/satOracle/oracle.js` — pure SGP4/geometry engine. Reuses
  the repo's existing SGP4 pass stack (`src/data/satellitePass.js`, satellite.js
  ^6.0.2): parseTleText, sub-satellite point, currentlyVisible (elevation +
  cylindrical-Earth-shadow sunlit filter), prefilterCandidates (Starlink
  prefilter: 1% sub-satellite sampling, 5° great-circle cutoff, max 250),
  tonightsVisiblePasses (twilight filter: observer Sun elevation −18°..−6°),
  passArcPoints, observerSolarElevation. Models labeled in JSDoc (USNO
  low-precision Sun, cylindrical shadow).
- `src/frontier/wave3/satOracle/satOracle.test.mjs` — 9 tests against a real
  CelesTrak ISS TLE fixture (fetch-mocked).
- `src/frontier/wave3/satOracle/index.js` — Cesium UI: user clicks the globe to
  set an observer point; "look up now" panel lists currently sunlit/visible
  satellites + tonight's twilight passes; pass arcs drawn as glowing polylines.
  Fail-soft: dead `/api/celestrak/*` shows an error line in the panel, never throws.
