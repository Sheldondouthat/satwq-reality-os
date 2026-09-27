# INTEGRATION — Wave 3 1.3 Cable-threat correlation

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

No change. Client-side only by design (see §5).

## 2. server/pages/registry.mjs

No change. **Registry-exclusion note:** the optional `/api/cable-threats`
was deliberately NOT built server-side. The cable polylines live as a
bundled client asset (`src/data/local_data/telegeography_submarine_cables/`);
a server join would need `node:fs` reads of a 728 KB GeoJSON on every cold
start — banned from the Pages bundle path — and the vessel rows are already
fetchable client-side from the same `/api/ais-live` endpoint the app's own
AIS layer uses. No new data source was introduced, so the PAGES_PORT.md
exclusion table needs no entry.

## 3. src/frontier/index.js

Add the import at the top (with the other feature imports):

```js
import { createCableThreatLayer, mountCableThreatDock } from './wave3/cableThreat/index.js';
```

Add the mount inside `initFrontier`, after the `// — W3.2 aviation SIGMETs —`
block:

```js
  // — W3.3 cable threats (AIS × submarine cables) —
  attempt('cable-threat', () => {
    const layer = createCableThreatLayer({ viewer });
    layer.init(viewer);
    trackLayer('cableThreat', layer);
    const dockCtl = mountCableThreatDock({ section, chip, el, t, layer });
    if (dockCtl) dock.appendChild(dockCtl.element);
    return () => { dockCtl?.destroy(); layer.destroy(); };
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js`:

```js
  'feature.cableThreat',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.cableThreat': 'Cable-threat correlation',
```

## Files owned by this feature (do not move)

- `src/frontier/wave3/cableThreat/model.js` — pure spatial join: cable
  GeoJSON → 11,989-segment grid index, haversine, point-to-segment,
  nearest-cable lookup, `SightingTracker` (30-min slow-near-stationary
  promotion), `joinPass`. Verified against the real bundled dataset.
- `src/frontier/wave3/cableThreat/index.js` — Cesium layer factory
  (`createCableThreatLayer`: loads cables via the existing
  `createBundledCableSource`, polls `/api/ais-live`, flashes threat
  segments red) + dock wiring (`mountCableThreatDock`).
- `src/frontier/wave3/cableThreat/cableThreat.test.mjs` — 12 tests.
