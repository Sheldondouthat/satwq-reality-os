# INTEGRATION — Wave 3 1.4 Terminator Rush

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

No change. Client-side only by design (pure solar math + existing feeds).

## 2. server/pages/registry.mjs

No change. **Registry-exclusion note:** nothing to exclude — no new server
provider was built. The feature consumes existing endpoints (`/api/firms`,
`/api/events`, `/api/nws-alerts`, `/api/sky-alerts`) from the browser, so
the PAGES_PORT.md exclusion table needs no entry.

## 3. src/frontier/index.js

Add the import at the top (with the other feature imports):

```js
import { createTerminatorRushLayer, mountTerminatorRushDock } from './wave3/terminatorRush/index.js';
```

Add the mount inside `initFrontier`, after the `// — W3.3 cable threats —`
block:

```js
  // — W3.4 terminator rush —
  attempt('terminator-rush', () => {
    const layer = createTerminatorRushLayer({ viewer });
    layer.init(viewer);
    trackLayer('terminatorRush', layer);
    const dockCtl = mountTerminatorRushDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js`:

```js
  'feature.terminatorRush',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.terminatorRush': 'Terminator Rush',
```

## Files owned by this feature (do not move)

- `src/frontier/wave3/terminatorRush/solar.js` — NOAA SPA-series solar
  math: subsolar point, solar elevation, closed twilight-loop tracing.
  Verified: equinox subsolar ≈ (0.6°, −1.8°), London elevation 39.1°,
  loop closes, all points on-target to 0.000°.
- `src/frontier/wave3/terminatorRush/model.js` — tolerant event
  normalization, per-feed best-effort gathering with `degradedSources`,
  band membership filter (cap 200 pins).
- `src/frontier/wave3/terminatorRush/index.js` — Cesium layer factory
  (`createTerminatorRushLayer`: glowing −4°/−6°/−8° loops + translucent
  band fill, live event pins, 60 s band / 5 min event refresh) + dock
  wiring (`mountTerminatorRushDock`, incl. fly-to-sunset).
- `src/frontier/wave3/terminatorRush/terminatorRush.test.mjs` — 12 tests.
