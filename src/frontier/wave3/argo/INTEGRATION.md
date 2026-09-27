# Wave 3 Track 2b — 2.9 Argo floats — Integration Guide

Argo drifting-profiler data provider: Ifremer ERDDAP `ArgoFloats` tabledap
(anonymous) → latest-fix-per-float constellation with best-effort surface
temperature at `/api/argo`. Data layer only — the ocean-twin UX is owned by
worker W10, which consumes the JSON contract below (or this feature's
frontend data client).

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/argo.js` | `export function argoProxy({fetchImpl})` — mounts `/api/argo`; two ERDDAP tabledap queries (positions `distinct()`, surface temp `pres<5`) reduced server-side to latest fix per float. Self-contained → workerd-safe. Exports `latestFixesPerFloat` + `medianSurfaceTempPerFloat`. |
| `src/frontier/wave3/argo/source.js` | `createArgoSource({fetchImpl, proxyBase, refreshMs})` — browser data client, fail-soft (30-min default refresh; floats drift slowly). |
| `src/frontier/wave3/argo/index.js` | `init(opts)` — fail-soft mount entry point; never throws. |
| `src/frontier/wave3/argo/argo.test.mjs` | 11 tests: mount, latest-fix reduction, temp median, null-coord guards, temp-query failure degradation, days clamp, all-down 502, frontend client. |

## 2. Probe outcomes (verified 2026-09-27 from sandbox)

| Fact | Detail |
|---|---|
| ERDDAP | `https://erddap.ifremer.fr/erddap/` anonymous; dataset `ArgoFloats` (tabledap) — 59 variables incl. `platform_number, time, latitude, longitude, position_qc, pres, temp` |
| Positions query | `tabledap/ArgoFloats.json?platform_number,time,latitude,longitude,position_qc&time>=<ISO>&distinct()` → one row per profile fix; 30-day window ≈ 1 MB |
| Temp query | `…?platform_number,time,temp&time>=<ISO>&pres<5&orderByLimit("time,15000")` — note ERDDAP orderByLimit syntax is `("col,n")` (n LAST); the `("n,col")` order 400s |
| Cadence | Floats surface ≈ every 10 days; ~4,000 active → a few hundred fresh fixes/day |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the vaac import:

```js
import { vaacProxy } from './vaac.js';
import { argoProxy } from './wave3/argo.js';   // ADD
```

and in `localProviderPlugins()`, after `vaacProxy(),`:

```js
    invisibleOceanProxy(),
    vaacProxy(),
    argoProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `vaac` entry:

```js
  {   // ADD
    name: 'argo',
    routes: ['/api/argo'],
    load: () => import('../providers/wave3/argo.js').then((m) => m.argoProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps, no cross-file imports.

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Argo } from './wave3/argo/index.js';   // ADD (top imports)
// inside initFrontier:
  // — Wave 3 Track 2b: Argo float constellation data (ocean-twin UX: W10) —
  attempt('wave3-argo', () => {
    const handle = initWave3Argo();
    return () => handle.stop();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

```js
  'feature.argo': 'Argo float constellation',
  'feature.argo.surfaceTemp': 'Near-surface temperature',
  'feature.argo.float': 'Argo float',
```

## 4. Consumer contract (for worker W10)

`GET /api/argo?days=30` → 200 (`days` 1–90, default 30)

```json
{
  "fetchedAt": 1758940000000, "windowDays": 30, "ttlMs": 1800000, "stale": false,
  "floats": [{
    "wmo": "1901514", "lat": 1.626, "lon": 44.637,
    "t": "2026-09-23T13:23:32Z", "qc": "1",
    "profilesInWindow": 2, "surfaceTempC": 27.6
  }],
  "tempCoverage": 1.0,
  "unavailable": false, "reason": null
}
```

- `wmo`: float identifier (string). `t`: latest fix time in the window.
  `qc`: raw `position_qc` flag. `surfaceTempC`: median of `<5 dbar`
  measurements in the **last 24 h** (a dedicated short temp query — the full
  window scan is too slow on ERDDAP, verified 2026-09-27) — SAMPLED,
  best-effort, may be partial (see `tempCoverage`); null when unavailable.
  NOT a calibrated SST product.
- Temp query failure never fails the request — positions are the product.
- Positions down + no cache → 502 `{error:'argo_upstream_unavailable'}`;
  down + cache → `stale:true`.

## 5. Behavior contract

- Cache TTL 30 min (floats drift slowly); body cap 1.5 MB per query;
  timeout 30 s.
- Null coordinates/temps are rejected explicitly (`Number(null) === 0`
  would otherwise fabricate a (0,0)/0 °C reading — guarded, tested).
- No keys, no paid deps, no WASM, no `node:` imports in the registry path.

## 6. Verification

```bash
cd ~/workspace/gods-eye-view
node --check server/providers/wave3/argo.js
node --check src/frontier/wave3/argo/source.js
node --check src/frontier/wave3/argo/index.js
node --test src/frontier/wave3/argo/argo.test.mjs
# live smoke (needs network):
curl -s 'http://localhost:4173/api/argo?days=7' | head -c 400
```

## 7. Known limits / follow-ups

- Positions are float fixes; drift between surfacings (~10 days) is unknown
  — do not interpolate tracks as measured paths.
- `surfaceTempC` is a window median of opportunity samples, not necessarily
  co-located in time with `t`. W10 may add a calibrated SST join later.
