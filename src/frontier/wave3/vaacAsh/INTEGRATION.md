# INTEGRATION — Wave 3 1.8 VAAC ash polygons

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import (after the `vaacProxy` import on line 31):

```js
import { vaacPolyProxy } from './wave3/vaacPoly.js';
```

Add the proxy in `localProviderPlugins()`, immediately after `vaacProxy(),`
(line 75), before `keySetupEndpoint()`:

```js
    vaacProxy(),
    vaacPolyProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no WASM —
PAGES_PORT.md exclusion table does not cover it). Add after the
`interplanetary` entry:

```js
  {
    name: 'vaac-polygons',
    routes: ['/api/vaac-polygons'],
    load: () => import('../providers/wave3/vaacPoly.js').then((m) => m.vaacPolyProxy()),
  },
```

## 3. src/frontier/index.js

Add the import at the top (with the other wave3 feature imports):

```js
import { createVaacAshLayer, mountVaacAshDock } from './wave3/vaacAsh/index.js';
```

Add the mount inside `initFrontier`, after the dot-cams block:

```js
  // — W3.8 VAAC ash polygons —
  attempt('vaac-ash', () => {
    const layer = createVaacAshLayer({ viewer });
    layer.init(viewer);
    trackLayer('vaacAsh', layer);
    const dockCtl = mountVaacAshDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js`:

```js
  'feature.vaacAsh',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.vaacAsh': 'Volcanic ash volumes',
```

## Files owned by this feature (do not move)

- `server/providers/wave3/vaacPoly.js` — provider factory (`vaacPolyProxy`),
  mounts `/api/vaac-polygons`. Washington VAAC index scrape → latest 8 XML
  advisories, IWXXM 3.0 parser (volcano metadata, issue/phenomenon times,
  `gml:posList` Lat/Long→[lon,lat], flight levels, observation + forecast
  volumes), 20-min cache, stale fallback, per-advisory fail-soft.
- `server/providers/wave3/vaacPoly.test.mjs` — 7 tests (fetch-mocked).
- `src/frontier/wave3/vaacAsh/model.js` — fetchVaacPolygons, flattenAshVolumes
  (observation + forecast records, FL→ft), crossAshWithAircraft (altitude-aware:
  horizontal inside + vertical within the FL band; unknown altitude ⇒
  horizontal match flagged `altUnknown`), fetchMilAircraft (keyless adsb.lol
  mil proxy).
- `src/frontier/wave3/vaacAsh/index.js` — Cesium layer; 3D extruded ash
  volumes (FL band → meters), observation red / forecast amber, ⚠ on volumes
  with aircraft inside.
- `src/frontier/wave3/vaacAsh/vaacAsh.test.mjs` — 5 tests.
