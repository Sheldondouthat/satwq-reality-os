# Wave 3 Track 2c / 2.17 — AISHub receiver-station mesh — Integration Guide

Renders AISHub's volunteer AIS **receiver stations** (keyless station
export) as globe markers, colored by station freshness. Receiver
infrastructure only — **no vessel positions**: live vessel data requires a
feeder account and is excluded by design.

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/aishub.js` | `export function aishubProxy({fetchImpl, now})` — mounts `/api/aishub`; drops zero-coordinate placeholders, reports placed-vs-zeroed counts. Workerd-safe. Exports `normalizeAishubStation`, `parseAishubStations`. |
| `src/frontier/wave3/aishub/model.js` | `freshnessBucket` (live/day/stale/unknown), `freshnessColorCss`, `pickStations` (live-first, capped). |
| `src/frontier/wave3/aishub/source.js` | `createAishubSource({fetchImpl, apiPath})` — browser snapshot client. |
| `src/frontier/wave3/aishub/index.js` | `init({viewer, apiPath})` — fail-soft Cesium mount; station markers colored by freshness, 30-min refresh. |
| `src/frontier/wave3/aishub/aishub.test.mjs` | 5 tests: real station rows, zero-placeholder rejection, placed/zeroed counts, freshness buckets, live-first ordering. |

## 2. Probe outcomes (verified 2026-09-27)

| Fact | Detail |
|---|---|
| Endpoint | `https://www.aishub.net/stations/export-json` → 200, 205,141 bytes, JSON array of `{id, country, location, latitude, longitude, unix_time}` |
| Sample | Real rows (e.g. #2011 Gothenburg `57.71, 11.97`); `0.00/0.00` rows are placeholders and are dropped |
| Vessel data | Live vessel positions require a feeder account — excluded; stations only |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the eibi import:

```js
import { eibiProxy } from './wave3/eibi.js';
import { aishubProxy } from './wave3/aishub.js';   // ADD
```

and in `localProviderPlugins()`, after `eibiProxy(),`:

```js
    eibiProxy(),
    aishubProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `eibi` entry:

```js
  {   // ADD
    name: 'aishub',
    routes: ['/api/aishub'],
    load: () => import('../providers/wave3/aishub.js').then((m) => m.aishubProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps; imports only `./lib/proxy.js` → `../../common/http.js` (plain fetch/JSON).

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Aishub } from './wave3/aishub/index.js';   // ADD (top imports)
// inside initFrontier (viewer is in scope):
  // — Wave 3 Track 2c / 2.17: AISHub receiver-station mesh —
  attempt('wave3-aishub', () => {
    const handle = initWave3Aishub({ viewer });
    return () => handle?.destroy?.();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

In the master key list (after `'feature.eibi',`):

```js
  'feature.aishub',
```

and in `BASE_STRINGS` (after `'feature.eibi.site': 'Transmitter site code',`):

```js
  'feature.aishub': 'AIS receiver mesh (AISHub)',
  'feature.aishub.live': 'Heard within the hour',
  'feature.aishub.day': 'Heard today',
  'feature.aishub.stale': 'Silent over a day',
```

## 4. Consumer contract

`GET /api/aishub` → 200

```json
{
  "fetchedAt": 1758940000000, "stale": false, "unavailable": false, "reason": null,
  "reported": 1042, "placed": 1019, "zeroed": 23,
  "stations": [{
    "id": "2011", "country": "se", "location": "Gothenburg",
    "lat": 57.71, "lon": 11.97, "lastSeen": 1790488502
  }]
}
```

- `zeroed`: rows with `0.00/0.00` coordinates, dropped server-side.
- Upstream down + no cache → 502; down + cache → `stale:true`.

## 5. Behavior contract

- Cache TTL 30 min; body cap 1 MB; timeout 20 s.
- Markers carry **receiver infrastructure only** — no vessel positions exist
  anywhere in this feature.
- Freshness colors: green = heard within the hour, gold = today, blue-grey = older.
- Keyless. No keys, no paid deps, no WASM, no `node:` imports in the registry path.
