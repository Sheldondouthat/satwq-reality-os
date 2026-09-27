# INTEGRATION — Wave 3 Track 2a.2: NOAA National Water Model (NWPS)

**Status:** built 2026-09-27 · source VERIFIED live (COMID 101 Neches River → 200 + short_range series)
**Files (mine only):**
- `server/providers/wave3/nwps.js` — `nwpsProxy()` factory → `/api/nwps`
- `src/frontier/wave3/nwps/model.js` — pure client model (trend colors, ribbon order)
- `src/frontier/wave3/nwps/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave3/nwps/nwps.test.mjs` — 11 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { nwpsProxy } from './wave3/nwps.js';
```

`localProviderPlugins()` array, after `nwisGaugesProxy(),`:
```js
    nwisGaugesProxy(),
    nwpsProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `nwis-gauges` entry (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'nwps',
    routes: ['/api/nwps'],
    load: () => import('../providers/wave3/nwps.js').then((m) => m.nwpsProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initNwps } from './wave3/nwps/index.js';
```

Inside `initFrontier`, after the nwis-gauges attempt block:
```js
  // — W3 2.2 NWPS flood-wave forecast —
  attempt('nwps', () => {
    const s = section(t('feature.nwps'));
    dock.appendChild(s);
    return initNwps({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.nwps',`
`BASE_STRINGS` += `'feature.nwps': 'Flood-wave forecast (NWM)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.nwps': 'Flood-wave prognosis'` |
| batcave | `'feature.nwps': 'Flood-wave forecast'` |
| garage | `'feature.nwps': 'Flood-wave forecast'` |
| noir | `'feature.nwps': 'Flood-wave forecast'` |
| lcars | `'feature.nwps': 'Flood-wave projection'` |
| pipboy | `'feature.nwps': 'Flood-wave forecast'` |
| jarvis | `'feature.nwps': 'Flood-wave forecast'` |
| nerv | `'feature.nwps': 'Flood-wave pattern'` |
| nightcity | `'feature.nwps': 'Flood-wave forecast'` |
| apollo | `'feature.nwps': 'Flood-wave forecast'` |
| weyland | `'feature.nwps': 'Flood-wave projection'` |
| synthwave | `'feature.nwps': 'Flood-wave forecast'` |
| scp | `'feature.nwps': 'Flood-wave forecast'` |
| tron | `'feature.nwps': 'Flood-wave program'` |

## API contract

`GET /api/nwps?comid=101,202&series=short_range`
(series ∈ short_range|medium_range|medium_range_blend|long_range|analysis_assimilation; ≤6 COMIDs)
→ `{ schemaVersion:1, series, reaches:[{reachId,name,lat,lon,referenceTime,units,
    series:[{validTime,flow}], trendPct, peakFlow, neighbors[]}], fetchedAt, stale, ... }`
- The provider fans out to each reach's immediate upstream/downstream
  neighbors (from the reach `route` block, ≤4, failures dropped) so one seed
  COMID grows a short river ribbon.
- Seed COMID `101` (Neches River, TX) is live-verified; neighbors are
  discovered, never hardcoded.

## Physics-honesty note (shown in the dock legend)
> NOAA National Water Model output — model forecast, not observed flooding.

## Verification
- Live: `api.water.noaa.gov/nwps/v1/reaches/101/streamflow?series=short_range` → HTTP 200,
  18 hourly steps. **VERIFIED.** Note: series data requires `?series=`; without it the
  endpoint returns metadata with empty series objects. `/nwps/v1/gauges` was
  unreachable (connection failed) — not used.
- Tests: `node --test src/frontier/wave3/nwps/nwps.test.mjs` → 13/13 pass.
