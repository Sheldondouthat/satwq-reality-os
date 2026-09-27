# INTEGRATION — Wave 3 1.1 NWS CAP alert polygons

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import (after the vaac import):

```js
import { nwsAlertsProxy } from './wave3/nwsAlerts.js';
```

Add the proxy in `localProviderPlugins()`, immediately before `keySetupEndpoint()`:

```js
    vaacProxy(),
    nwsAlertsProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM — PAGES_PORT.md exclusion table does not cover it). Add after the
`vaac` entry, before the closing `];`:

```js
  {
    name: 'nws-alerts',
    routes: ['/api/nws-alerts'],
    load: () => import('../providers/wave3/nwsAlerts.js').then((m) => m.nwsAlertsProxy()),
  },
```

## 3. src/frontier/index.js

Add the import at the top (with the other feature imports):

```js
import { createNwsAlertsLayer, mountNwsAlertsDock } from './wave3/nwsAlerts/index.js';
```

Add the mount inside `initFrontier`, after the `// — F13 invisible ocean —`
block and before the `// — F9 forecast layers —` block:

```js
  // — W3.1 NWS alert polygons —
  attempt('nws-alerts', () => {
    const layer = createNwsAlertsLayer({ viewer });
    layer.init(viewer);
    trackLayer('nwsAlerts', layer);
    const dockCtl = mountNwsAlertsDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js`:

```js
  'feature.nwsAlerts',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.nwsAlerts': 'NWS alert polygons',
```

## Files owned by this feature (do not move)

- `server/providers/wave3/nwsAlerts.js` — provider factory (`nwsAlertsProxy`),
  mounts `/api/nws-alerts`, 5-min cache, trimmed GeoJSON.
- `server/providers/wave3/nwsAlerts.test.mjs` — 7 tests (fetch-mocked).
- `src/frontier/wave3/nwsAlerts/model.js` — severity grading, centroid/bbox,
  fire-perimeter cross, filtering.
- `src/frontier/wave3/nwsAlerts/panel.js` — click-for-details panel.
- `src/frontier/wave3/nwsAlerts/index.js` — Cesium layer factory
  (`createNwsAlertsLayer`) + dock wiring (`mountNwsAlertsDock`).
- `src/frontier/wave3/nwsAlerts/nwsAlerts.test.mjs` — 11 tests.
