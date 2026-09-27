# INTEGRATION — Wave 3 Track 2a.1: USGS NWIS gauges

**Status:** built 2026-09-27 · source VERIFIED live (HTTP 200, WaterML JSON, live readings)
**Files (mine only — do not touch other workers' files):**
- `server/providers/wave3/nwisGauges.js` — `nwisGaugesProxy()` factory → `/api/nwis-gauges`
- `src/frontier/wave3/nwisGauges/model.js` — pure client model (colors, pulse, labels)
- `src/frontier/wave3/nwisGauges/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave3/nwisGauges/nwisGauges.test.mjs` — 17 tests, all passing

## 1. `server/providers/local.js` — exact lines

Add to the import block (after the `vaac` import):
```js
import { nwisGaugesProxy } from './wave3/nwisGauges.js';
```

Add to `localProviderPlugins()` array, after `vaacProxy(),`:
```js
    vaacProxy(),
    nwisGaugesProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY`, after the `vaac` entry (provider is pure fetch/JSON —
no `node:` imports, no WASM — so it is Pages-safe, no exclusion):
```js
  {
    name: 'nwis-gauges',
    routes: ['/api/nwis-gauges'],
    load: () => import('../providers/wave3/nwisGauges.js').then((m) => m.nwisGaugesProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Add to the import block:
```js
import { init as initNwisGauges } from './wave3/nwisGauges/index.js';
```

Add inside `initFrontier`, after the `// — F13 invisible ocean —` attempt block:
```js
  // — W3 2.1 NWIS river gauges —
  attempt('nwis-gauges', () => {
    const s = section(t('feature.nwisGauges'));
    dock.appendChild(s);
    return initNwisGauges({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — add to `REQUIRED_KEYS`:
```js
  'feature.nwisGauges',
```
Add to `BASE_STRINGS`:
```js
  'feature.nwisGauges': 'River gauges (USGS)',
```

`src/themes/themes.js` — add to each theme's `strings` block (after the
`feature.*` entries; `t()` falls back to BASE_STRINGS if a theme omits it):
| theme | string |
|---|---|
| medbay | `'feature.nwisGauges': 'River vitals'` |
| batcave | `'feature.nwisGauges': 'River gauge grid'` |
| garage | `'feature.nwisGauges': 'River gauges'` |
| noir | `'feature.nwisGauges': 'River gauge wire'` |
| lcars | `'feature.nwisGauges': 'Hydrology telemetry'` |
| pipboy | `'feature.nwisGauges': 'River gauges'` |
| jarvis | `'feature.nwisGauges': 'River gauge telemetry'` |
| nerv | `'feature.nwisGauges': 'River gauge net'` |
| nightcity | `'feature.nwisGauges': 'River gauge feed'` |
| apollo | `'feature.nwisGauges': 'River gauge telemetry'` |
| weyland | `'feature.nwisGauges': 'Hydrology assets'` |
| synthwave | `'feature.nwisGauges': 'River gauges'` |
| scp | `'feature.nwisGauges': 'Hydrology telemetry'` |
| tron | `'feature.nwisGauges': 'River gauge grid'` |

## API contract

`GET /api/nwis-gauges?bbox=minLon,minLat,maxLon,maxLat` (default CONUS `-125,24,-66,50`)
→ `{ schemaVersion:1, gauges:[{id,name,lat,lon,flowCfs,flowZ,flowN,heightFt,heightZ,timeMs}],
    count, anomalyBasis, bbox, fetchedAt, stale, attribution, ... }`
- `anomalyBasis`: `"trailing P2D z-score per gauge"` (small bbox) or
  `"latest-only (magnitude, no anomaly)"` (continental view). The client legend
  states the z-score is per-gauge history, **not flood stage**.

## Physics-honesty note (shown in the dock legend)
> Anomaly = trailing-window z-score per gauge, not flood stage. Size = discharge (log).

## Verification
- Live: `waterservices.usgs.gov/nwis/iv/?format=json&bBox=-87.5,33,-86.5,34&parameterCd=00060,00065`
  → HTTP 200, 92 time series, live 2026-09-27 values. **VERIFIED.**
- Tests: `node --test src/frontier/wave3/nwisGauges/nwisGauges.test.mjs` → 17/17 pass.
