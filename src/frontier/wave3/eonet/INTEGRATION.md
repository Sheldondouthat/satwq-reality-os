# Wave 3 Track 2b — 2.10 NASA EONET v3 — Integration Guide

Natural-events data provider: NASA EONET v3 (keyless) → normalized event
list with latest fix + reported-fix polylines at `/api/eonet`. Data layer
only — hazard markers + storm polylines are rendered by a sibling worker,
which consumes the JSON contract below (or this feature's frontend data
client).

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/eonet.js` | `export function eonetProxy({fetchImpl})` — mounts `/api/eonet`; validates `status/days/category`, normalizes events server-side (latest fix, ≤200-point downsampled track, coordinate validation). Self-contained → workerd-safe. Exports `normalizeEvent` + `parseQuery`. |
| `src/frontier/wave3/eonet/source.js` | `createEonetSource({fetchImpl, proxyBase, refreshMs})` — browser data client, fail-soft (15-min default refresh). |
| `src/frontier/wave3/eonet/index.js` | `init(opts)` — fail-soft mount entry point; never throws. |
| `src/frontier/wave3/eonet/eonet.test.mjs` | 14 tests: mount, query parsing/validation, event normalization (lon/lat order, invalid-coord drops, downsampling endpoints), newest-first ordering, category passthrough, 400/502, frontend client. |

## 2. Probe outcomes (verified 2026-09-27 from sandbox)

| Fact | Detail |
|---|---|
| Endpoint | `https://eonet.gsfc.nasa.gov/api/v3/events?status=open&days=30` → 200, keyless |
| Shape | `{title, description, link, events:[{id, title, description, link, closed, categories:[{id,title}], sources:[{id,url}], geometry:[{magnitudeValue, magnitudeUnit, date, type, coordinates:[lon,lat]}]}]}` |
| Coordinates | GeoJSON order `[lon, lat]` — preserved as `[lon, lat]` in `track` |
| Live sample | Tropical Storm Gonzalo (severeStorms, NOAA_NHC source, 40 kts fixes), Iceberg D33C (seaLakeIce) |
| Magnitudes | Agency values in agency units (kts, km, …) — passed through, never converted |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the vaac import:

```js
import { vaacProxy } from './vaac.js';
import { eonetProxy } from './wave3/eonet.js';   // ADD
```

and in `localProviderPlugins()`, after `vaacProxy(),`:

```js
    invisibleOceanProxy(),
    vaacProxy(),
    eonetProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `vaac` entry:

```js
  {   // ADD
    name: 'eonet',
    routes: ['/api/eonet'],
    load: () => import('../providers/wave3/eonet.js').then((m) => m.eonetProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps, no cross-file imports.

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Eonet } from './wave3/eonet/index.js';   // ADD (top imports)
// inside initFrontier:
  // — Wave 3 Track 2b: EONET natural-events data (hazard UX separate) —
  attempt('wave3-eonet', () => {
    const handle = initWave3Eonet();
    return () => handle.stop();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

```js
  'feature.eonet': 'Natural events (EONET)',
  'feature.eonet.track': 'Reported track',
  'feature.eonet.latest': 'Latest fix',
```

## 4. Consumer contract

`GET /api/eonet?status=open&days=30&category=severeStorms`

- `status`: `open|closed` (default `open`). `days`: 1–60 (default 30).
  `category`: one of drought, dustHaze, earthquakes, floods, landslides,
  manmade, seaLakeIce, severeStorms, snow, tempExtremes, volcanoes,
  waterColor, wildfires (default all). Invalid values → 400.
- 200 →

```json
{
  "fetchedAt": 1758940000000,
  "query": { "status": "open", "days": 30, "category": null },
  "ttlMs": 900000, "stale": false, "count": 2,
  "events": [{
    "id": "EONET_24811", "title": "Tropical Storm Gonzalo",
    "categories": ["severeStorms"],
    "sources": [{ "id": "NOAA_NHC", "url": "https://www.nhc.noaa.gov/archive/2026/GONZALO.shtml" }],
    "latest": { "t": "2026-09-25T15:00:00Z", "lon": -22.7, "lat": 15.1, "mag": 45, "magUnit": "kts" },
    "track": [[-22.1, 13.2], [-22.4, 14.2], [-22.7, 15.1]],
    "geometryCount": 3
  }],
  "unavailable": false, "reason": null
}
```

- Events sorted newest-first by latest fix. `track` connects **reported
  fixes only** — NOT a forecast, NOT a measured continuous path. Magnitudes
  are agency-reported, units as-reported.
- Upstream down + no cache → 502 `{error:'eonet_upstream_unavailable'}`;
  down + cache → `stale:true`.

## 5. Behavior contract

- Cache TTL 15 min; body cap 2 MB; timeout 20 s.
- Invalid coordinates (out-of-range lon/lat, missing date) are dropped,
  never clamped into place.
- No keys, no paid deps, no WASM, no `node:` imports in the registry path.

## 6. Verification

```bash
cd ~/workspace/gods-eye-view
node --check server/providers/wave3/eonet.js
node --check src/frontier/wave3/eonet/source.js
node --check src/frontier/wave3/eonet/index.js
node --test src/frontier/wave3/eonet/eonet.test.mjs
# live smoke (needs network):
curl -s 'http://localhost:4173/api/eonet?category=severeStorms' | head -c 400
```

## 7. Known limits / follow-ups

- EONET is an aggregator; fix cadence and latency depend on the source
  agency (NHC, NATICE, …). `closed:null` means open in v3.
- Track polylines for non-storm categories are usually single points —
  render as markers, not lines, when `geometryCount < 2`.
