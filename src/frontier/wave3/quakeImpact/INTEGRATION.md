# INTEGRATION.md — 1.12 DYFI/ShakeMap impact (`wave3/quakeImpact`)

Feature dir: `src/frontier/wave3/quakeImpact/`
Tests: `src/frontier/wave3/quakeImpact/quakeImpact.test.mjs` (10) — all passing.
No server provider (client-side: USGS serves CORS; no proxy needed). No shared-file edits.
Live verifications (2026-09-27): on event `us7000ti1p` (M6.5, Alaska) the
ComCat detail document exposes `dyfi` → `dyfi_geo_10km.geojson` (felt cells
with `cdi`), `shakemap` → `download/cont_mmi.json` (MMI contour GeoJSON
with `properties.value` in MMI), `losspager` → `json/alerts.json`
(`{fatality:{level,bins}, economic:{level,bins}}`); `properties.alert`
carries the PAGER level directly.

## Modules

- `impact.js` — `getQuakeImpact(eventId, {fetchImpl})`:
  `{eventId, mag, place, timeMs, lat, lon, pager, dyfi, shakemap}` where each
  product is `{available, kind:'model'|'observation', ...}`. Product URLs are
  origin-checked to `https://earthquake.usgs.gov` before fetch (ComCat URLs
  are data, not trusted destinations). `findLargestRecentQuake` powers the
  "latest big quake" button. `normalizeDyfi` / `normalizeMmiContours` /
  `mmiColor` / `pagerColor` are pure and tested.
- `index.js` — `initQuakeImpact({viewer, mount, fetchImpl})`: dock panel
  (event-id input + "latest big quake"), PAGER badge, DYFI felt heat as
  Cesium points (observation), ShakeMap MMI contours as Cesium polygons
  (model). Fail-soft.

## 1. Exact lines for `server/providers/local.js`

None — no provider.

## 2. Exact lines for `server/pages/registry.mjs`

None — no new routes. Exclusion note: not applicable (no provider exists).

## 3. Exact mount call for `initFrontier` (inside the `initFrontier` body)

Add the import at the top of `src/frontier/index.js`:

```js
import { initQuakeImpact } from './wave3/quakeImpact/index.js';
```

Add a mount attempt (after the watch-replay block):

```js
  // — Wave 3 · 1.12 DYFI/ShakeMap impact —
  attempt('quake-impact', () => {
    const s = section(t('feature.quakeImpact'));
    const handle = initQuakeImpact({
      viewer,
      mount: (node) => s.appendChild(node),
    });
    dock.appendChild(s);
    return () => handle.destroy();
  });
```

## 4. New UI strings for theme dictionaries

```js
'feature.quakeImpact': 'Quake impact — felt & shaking',
```

## Honesty notes for the UI copy

- ShakeMap contours are labeled MODELED shaking (not measured).
- DYFI is labeled felt REPORTS (crowdsourced; sparse/no coverage offshore).
- PAGER is labeled a modeled loss ESTIMATE.
- Each product degrades independently with `available:false` — a quake with
  no DYFI product shows PAGER + ShakeMap, never a blank failure.
