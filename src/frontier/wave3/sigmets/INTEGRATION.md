# INTEGRATION — Wave 3 1.2 Aviation SIGMETs

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import (after the vaac import):

```js
import { sigmetsProxy } from './wave3/sigmets.js';
```

Add the proxy in `localProviderPlugins()`, immediately before `keySetupEndpoint()`:

```js
    vaacProxy(),
    sigmetsProxy(),
    keySetupEndpoint(),
```

(If the 1.1 worker already added `nwsAlertsProxy()` there, order is
`nwsAlertsProxy(), sigmetsProxy(), keySetupEndpoint()` — order between the
two wave3 providers does not matter.)

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM). Add after the `vaac` entry (or after the `nws-alerts` entry), before
the closing `];`:

```js
  {
    name: 'sigmets',
    routes: ['/api/sigmets', '/api/airports/metar', '/api/airports/taf'],
    load: () => import('../providers/wave3/sigmets.js').then((m) => m.sigmetsProxy()),
  },
```

## 3. src/frontier/index.js

Add the import at the top (with the other feature imports):

```js
import { createSigmetsLayer, mountSigmetsDock } from './wave3/sigmets/index.js';
```

Add the mount inside `initFrontier`, after the `// — W3.1 NWS alert polygons —`
block (or after F13 invisible ocean if 1.1 is absent):

```js
  // — W3.2 aviation SIGMETs —
  attempt('sigmets', () => {
    const layer = createSigmetsLayer({ viewer });
    layer.init(viewer);
    trackLayer('sigmets', layer);
    const dockCtl = mountSigmetsDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js`:

```js
  'feature.sigmets',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.sigmets': 'Aviation SIGMETs',
```

## Files owned by this feature (do not move)

- `server/providers/wave3/sigmets.js` — provider factory (`sigmetsProxy`),
  mounts `/api/sigmets`, `/api/airports/metar`, `/api/airports/taf`;
  5-min cache; station allow-list `^[A-Z0-9]{3,5}$`, max 20 ids.
- `server/providers/wave3/sigmets.test.mjs` — 9 tests (fetch-mocked).
- `src/frontier/wave3/sigmets/model.js` — hazard colors/labels, altitude
  ranges, expiry, METAR flight-category colors, 20-station dot list.
- `src/frontier/wave3/sigmets/index.js` — Cesium layer factory
  (`createSigmetsLayer`, extruded volumes + airport dots) + dock wiring
  (`mountSigmetsDock`).
- `src/frontier/wave3/sigmets/sigmets.test.mjs` — 10 tests.
