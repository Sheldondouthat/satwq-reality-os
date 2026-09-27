# INTEGRATION — Wave 3 1.7 DOT weather-cam mesh

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import (after the `vaacProxy` import on line 31):

```js
import { dotCamsProxy } from './wave3/dotCams.js';
```

Add the proxy in `localProviderPlugins()`, immediately after `vaacProxy(),`
(line 75), before `keySetupEndpoint()`:

```js
    vaacProxy(),
    dotCamsProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no WASM —
PAGES_PORT.md exclusion table does not cover it). Add after the
`interplanetary` entry:

```js
  {
    name: 'dot-cams',
    routes: ['/api/dot-cams', '/api/dot-cams/image'],
    load: () => import('../providers/wave3/dotCams.js').then((m) => m.dotCamsProxy()),
  },
```

## 3. src/frontier/index.js

Add the import at the top (with the other wave3 feature imports):

```js
import { createDotCamsLayer, mountDotCamsDock } from './wave3/dotCams/index.js';
```

Add the mount inside `initFrontier`, after the sat-oracle block:

```js
  // — W3.7 DOT weather-cam mesh —
  attempt('dot-cams', () => {
    const layer = createDotCamsLayer({ viewer });
    layer.init(viewer);
    trackLayer('dotCams', layer);
    const dockCtl = mountDotCamsDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js`:

```js
  'feature.dotCams',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.dotCams': 'DOT weather-cam mesh',
```

## Files owned by this feature (do not move)

- `server/providers/wave3/dotCams.js` — provider factory (`dotCamsProxy`),
  mounts `/api/dot-cams` (Caltrans D1–D12 district JSON + Iowa 511/CARS, 10-min
  cache, stale fallback, `?state=CA|IA` filter) and `/api/dot-cams/image`
  (302 redirect to allow-listed DOT still-image hosts; non-listed hosts are
  never fetched).
- `server/providers/wave3/dotCams.test.mjs` — 10 tests (fetch-mocked).
- `src/frontier/wave3/dotCams/model.js` — fetchDotCams, haversineKm,
  nearestCams, weatherCamStillUrl.
- `src/frontier/wave3/dotCams/index.js` — Cesium layer; renders the nearest
  600 cameras to the camera target (refreshed on move); click a marker to open
  a panel with the live still (auto-refreshes every 60 s).
- `src/frontier/wave3/dotCams/dotCams.test.mjs` — 4 tests.

## Verification notes / gaps

- NY511: no keyless camera API found (`/georss` → `/notfound`); Mass511 is an
  SPA with no verified public feed; WSDOT requires an API key.
- Extra-state sweep 2026-09-27 (all unverified, not wired): guessed camera-API
  paths for SD CARS (`sd.carsprogram.org/cameras_v1/api/cameras` → 404),
  TripCheck (`/api/cctv` → HTML), 511 Virginia (`/api/cameras` → 301),
  COtrip (`/api/cameras` → HTML), 511 MN (`/api/cameras` → HTML), FL511
  (`/api/cameras` → 404 JSON "No HTTP resource was found"). FL511 exposes an
  ASP.NET Web API but route names were not recovered from its public JS.
  No additional state verified — CA + IA only, requirement's "NY511 plus 3–5
  states" is NOT met; honest shortfall.
- Caltrans D12 verified live 2026-09-27 (HTTP 200, 419 records, nested `{cctv}`
  wrapper with the same inner schema) and wired into `CALTRANS_DISTRICTS`.
