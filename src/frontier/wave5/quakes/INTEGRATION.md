# INTEGRATION.md — Wave 5 global quake aggregation (`wave5/quakes`)

Feature dir: `src/frontier/wave5/quakes/`
Server provider: `server/providers/wave5/quakes.js` (+ `quakes.test.mjs`, 14 tests — all passing)
Vercel route: `api/quakes.js`
Client tests: `src/frontier/wave5/quakes/model.test.mjs` (10) — all passing, runs in `node scripts/run-unit-tests.mjs` scope.

## What it does

`GET /api/quakes` aggregates five keyless quake catalogs into one normalized,
cross-catalog-deduped snapshot:

| key    | catalog entry | upstream                                                        |
|--------|---------------|-----------------------------------------------------------------|
| usgs   | #95           | `earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson` |
| jma    | #100          | `www.jma.go.jp/bosai/quake/data/list.json`                      |
| bmkg   | #101          | `data.bmkg.go.id/DataMKG/TEWS/autogempa.json`                   |
| geonet | #102          | `api.geonet.org.nz/quake?MMI=3`                                 |
| emsc   | #97           | `seismicportal.eu/fdsnws/event/1/query?format=json&limit=5&minmag=5` |

Payload: `{generatedAt, sources:{<key>:{ok,count,attribution,latencyMs,error?}}, count, merged, quakes:[{id,lat,lon,depthKm,mag,place,time,sources[]}]}`.
Duplicate reports of one event merge when |Δt| ≤ 120 s, distance ≤ 50 km,
|Δmag| ≤ 0.8; the merged entry keeps the higher-mag report's fields and unions
source keys. Per-source failures degrade honestly (`sources.<key>.ok:false` with
`error`); 502 `{error:'quakes_unavailable'}` only when ALL five fail.

The frontier layer draws magnitude-sized/colored Cesium points (labels on M6+),
click-for-details descriptions, a dock chip, top-3 list, and a legend. Refresh
5 min. Fail-soft.

Relation to existing quake UI: `src/layers/earthquakes/` shows the USGS 24h
feed alone with its own overlay/cohort treatment; `src/frontier/wave3/quakeImpact/`
does per-event DYFI/ShakeMap/PAGER impact. This feature is the five-catalog
aggregate — the legend and description both say so. No duplication of their
UI.

DYFI (#96) is Wave C — NOT built here.

## 1. Exact lines for `server/pages/registry.mjs`

Add the entry before the closing `];` (after the water-twin entry):

```js
  {
    name: 'quakes',
    routes: ['/api/quakes'],
    load: () => import('../providers/wave5/quakes.js').then((m) => m.quakesProxy()),
  },
```

## 2. Exact lines for `server/providers/local.js`

Add the import (after the last wave3 import line):

```js
import { quakesProxy } from './wave5/quakes.js';
```

Add the plugin line (after `reentriesProxy(),`, before `keySetupEndpoint(),`):

```js
    reentriesProxy(),
    quakesProxy(),
    keySetupEndpoint(),
```

## 3. Exact mount call for `initFrontier` (inside the `initFrontier` body)

Add the import at the top of `src/frontier/index.js` (after the last import):

```js
import { init as initWave5Quakes } from './wave5/quakes/index.js';
```

Add the mount block after the reentry block, before the `return {`:

```js
  // — Wave 5: global quake aggregation (USGS + JMA + BMKG + GeoNet + EMSC) —
  attempt('wave5-quakes', () => {
    const s = section(t('feature.quakes'));
    const handle = initWave5Quakes({
      viewer,
      mount: (node) => s.appendChild(node),
      chip,
      trackLayer,
      t,
    });
    dock.appendChild(s);
    return () => handle?.();
  });
```

## 4. New UI strings for theme dictionaries

Add after the `'feature.reentry'` line in EACH of the 14 theme dictionaries in
`src/themes/themes.js` (lines ~146, 265, 384, 504, 623, 743, 862, 981, 1100,
1219, 1339, 1458, 1577, 1696):

```js
'feature.quakes': "Global quakes (5-catalog)",
```

The chip and section fall back to `'Global quakes'` if a theme is missing the
key, so a partially-applied theme edit degrades gracefully — but all 14 should
be updated for consistency.

## Honesty notes for the UI copy

- The description footer on every quake point says duplicate reports of one
  event are merged — never presented as independent confirmations.
- Magnitudes/depths come from the reporting catalog; different catalogs can
  disagree slightly on the same event.
- Each source degrades independently: the dock status shows e.g. "4/5
  catalogs live" rather than failing the whole feed.
- JMA place names prefer the English `en_anm` field with the Japanese `anm`
  as fallback; BMKG `Wilayah` strings are in Indonesian.
