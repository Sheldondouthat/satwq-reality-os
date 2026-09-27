# INTEGRATION — Wave 3 1.5 TFR lockdown overlay

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import (after the `vaacProxy` import on line 31):

```js
import { tfrProxy } from './wave3/tfr.js';
```

Add the proxy in `localProviderPlugins()`, immediately after `vaacProxy(),`
(line 75), before `keySetupEndpoint()`:

```js
    vaacProxy(),
    tfrProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no WASM —
PAGES_PORT.md exclusion table does not cover it). Add after the
`interplanetary` entry:

```js
  {
    name: 'tfr',
    routes: ['/api/tfrs'],
    load: () => import('../providers/wave3/tfr.js').then((m) => m.tfrProxy()),
  },
```

## 3. src/frontier/index.js

Add the import at the top (with the other wave3 feature imports):

```js
import { createTfrLayer, mountTfrDock } from './wave3/tfr/index.js';
```

Add the mount inside `initFrontier`, after the NWS-alerts block:

```js
  // — W3.5 TFR lockdown overlay —
  attempt('tfr', () => {
    const layer = createTfrLayer({ viewer });
    layer.init(viewer);
    trackLayer('tfr', layer);
    const dockCtl = mountTfrDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js`:

```js
  'feature.tfrLockdown',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.tfrLockdown': 'TFR lockdown overlay',
```

## Files owned by this feature (do not move)

- `server/providers/wave3/tfr.js` — provider factory (`tfrProxy`), mounts
  `/api/tfrs`. FAA tfrapi list + per-NOTAM XML detail (`download/detail_<id>.xml`),
  parses `<abdMergedArea>/<Avx>` geometry, `<geoLat>`/`<geoLong>`, vertical limits,
  effective/expiry. 10-min cache + stale fallback. Concurrency-limited detail fan-out.
  **Pages subrequest safety:** detail fetches are hard-capped at DETAIL_LIMIT=40
  (1 list + 40 details = 41 < 50 free-plan subrequests/invocation); entries past
  the cap are still listed but geometry-less, and `withGeometry` reports honest
  partial coverage. Regression-tested with stubbed fetch.
- `server/providers/wave3/tfr.test.mjs` — 10 tests (fetch-mocked, incl. the
  DETAIL_LIMIT subrequest-budget regression test).
- `src/frontier/wave3/tfr/model.js` — fetchTfrs, pointInRing, tfrCentroid,
  flagFlightsInsideTfrs (aircraft inside active polygons), crossTfrsWithFires
  (trivial bbox cross with /api/fire-perimeters), fetchMilAircraft (keyless
  adsb.lol mil proxy).
- `src/frontier/wave3/tfr/index.js` — Cesium layer + dock mounter; red TFR
  polygons, ⚠ flags on TFRs with aircraft inside, 🔥 marks on fire overlaps.
- `src/frontier/wave3/tfr/tfr.test.mjs` — 6 tests (fetch-mocked).
