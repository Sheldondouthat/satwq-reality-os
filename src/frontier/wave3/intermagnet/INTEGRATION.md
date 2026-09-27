# Wave 3 Track 2b — 2.7 INTERMAGNET HAPI — Integration Guide

Geomagnetic observatory data provider: INTERMAGNET HAPI 3.1
(`imag-data.bgs.ac.uk/GIN_V1/hapi`) → per-observatory field-magnitude
snapshots with short-window anomaly at `/api/geomag`. Data layer only —
the magnetic-anomaly shimmer UX is owned by a sibling worker, which
consumes the JSON contract below (or this feature's frontend data client).

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/intermagnet.js` | `export function intermagnetProxy({fetchImpl})` — mounts `/api/geomag`; per-observatory `/info` (cached 24 h, learns `stopDate`) then `/data` for the last 120 min of `Field_Magnitude`. Self-contained → workerd-safe. Exports `hapiOk` + `normalizeObservatory`. |
| `src/frontier/wave3/intermagnet/source.js` | `createGeomagSource({fetchImpl, proxyBase, refreshMs})` — browser data client, fail-soft. |
| `src/frontier/wave3/intermagnet/index.js` | `init(opts)` — fail-soft mount entry point; never throws. |
| `src/frontier/wave3/intermagnet/intermagnet.test.mjs` | 10 tests: mount, HAPI envelope check, anomaly math, per-observatory error isolation, all-down 502, frontend client. |

## 2. Probe outcomes (verified 2026-09-27 from sandbox)

| Fact | Detail |
|---|---|
| HAPI version | 3.1 (`/capabilities` → `{"HAPI":"3.1","status":{"code":1200}}`) |
| Catalog | 3,074 datasets; near-real-time series under `<code>/best-avail/PT1M/xyzf` |
| Parameters | `Time`, `Field_Vector` (nT×3), `Field_Magnitude` (nT) — per `/info` |
| Data shape | `{"HAPI":"3.1","status":{"code":1200},"data":[["2026-09-25T00:00Z",53410.6094],…]}` — 1-min cadence |
| Freshness | `stopDate` lags ~hours–1 day per observatory (Ottawa stopped 2026-09-26T05:55Z at probe time); the provider reads `stopDate` from `/info` instead of assuming "now" |
| Query gotcha | Wrong parameter names → HAPI 1400; window past `stopDate` → 1400/1405. Handled per-observatory (isolated failure, never all-or-nothing) |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the vaac import:

```js
import { vaacProxy } from './vaac.js';
import { intermagnetProxy } from './wave3/intermagnet.js';   // ADD
```

and in `localProviderPlugins()`, after `vaacProxy(),`:

```js
    invisibleOceanProxy(),
    vaacProxy(),
    intermagnetProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `vaac` entry:

```js
  {   // ADD
    name: 'intermagnet',
    routes: ['/api/geomag'],
    load: () => import('../providers/wave3/intermagnet.js').then((m) => m.intermagnetProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps, no cross-file imports.

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Geomag } from './wave3/intermagnet/index.js';   // ADD (top imports)
// inside initFrontier:
  // — Wave 3 Track 2b: INTERMAGNET geomagnetic data (shimmer UX separate) —
  attempt('wave3-geomag', () => {
    const handle = initWave3Geomag();
    return () => handle.stop();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

```js
  'feature.geomag': 'Geomagnetic observatories (INTERMAGNET)',
  'feature.geomag.anomaly': 'Field anomaly',
  'feature.geomag.station': 'Magnetic observatory',
```

## 4. Consumer contract

`GET /api/geomag` → 200

```json
{
  "fetchedAt": 1758940000000,
  "windowMin": 120, "ttlMs": 600000, "stale": false,
  "observatories": [{
    "code": "OTT", "name": "Ottawa", "lat": 45.403, "lon": -75.552,
    "dataset": "ott/best-avail/PT1M/xyzf",
    "latest": { "t": "2026-09-26T05:55Z", "f": 53415.0 },
    "medianF": 53411.21, "anomalyNT": 3.79, "samples": 118,
    "status": "ok"
  }],
  "unavailable": false, "reason": null
}
```

- `anomalyNT` = latest F − 120-min median F, nT — DERIVED short-window
  disturbance index. Label as relative/model; NOT a storm scale, NOT Kp/Dst.
- `status: 'error'` per observatory on HAPI 1400/1405/fetch failure — the
  rest still serve. All down + no cache → 502
  `{error:'geomag_upstream_unavailable'}`; all down + cache → `stale:true`.

## 5. Behavior contract

- 8 curated observatories (IAGA codes + published coordinates baked in):
  OTT, NGK, HER, KAK, HON, AAE, MBO, ESK.
- `/info` cached 24 h (stopDate discovery); data cache 10 min; body cap
  256 KB per upstream call; timeout 20 s.
- No keys, no paid deps, no WASM, no `node:` imports in the registry path.

## 6. Verification

```bash
cd ~/workspace/gods-eye-view
node --check server/providers/wave3/intermagnet.js
node --check src/frontier/wave3/intermagnet/source.js
node --check src/frontier/wave3/intermagnet/index.js
node --test src/frontier/wave3/intermagnet/intermagnet.test.mjs
# live smoke (needs network):
curl -s 'http://localhost:4173/api/geomag' | head -c 400
```

## 7. Known limits / follow-ups

- `best-avail` freshness varies by observatory (hours–day lag); the
  snapshot's `latest.t` is per-observatory — consumers must not assume a
  common timestamp.
- 120-min median is a local reference only; secular variation and
  diurnal Sq currents move the baseline — do not present `anomalyNT` as an
  absolute storm measurement.
