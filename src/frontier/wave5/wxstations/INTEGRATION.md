# INTEGRATION — Wave 5: global weather-station ticker (catalog Wave A item 18)

**Status:** built 2026-09-27 · all 9 upstreams VERIFIED live (NWS KROA 200;
METNO compact 200; SMHI 235 stations; HKO rhrread 200; NEA 200; IPMA 227
stations; IMGW 62 synop rows; Met Éireann athenry 200; IMO ids=1 200)
**Files (mine only):**
- `server/providers/wave5/wxstations.js` — `wxstationsProxy()` factory → `/api/wxstations`
- `server/providers/wave5/wxstations.test.mjs` — 15 tests, all passing
- `api/wxstations.js` — Vercel mount (shared connect adapter)
- `src/frontier/wave5/wxstations/model.js` — pure client model
- `src/frontier/wave5/wxstations/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave5/wxstations/wxstations.test.mjs` — 7 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { wxstationsProxy } from './wave5/wxstations.js';
```

`localProviderPlugins()` array, after `reentriesProxy(),`:
```js
    reentriesProxy(),
    wxstationsProxy(),
    timeProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `water-twin` entry (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'wxstations',
    routes: ['/api/wxstations'],
    load: () => import('../providers/wave5/wxstations.js').then((m) => m.wxstationsProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initWxstations } from './wave5/wxstations/index.js';
```

Inside `initFrontier`, after the wave3 mount blocks (next to donki):
```js
  // — Wave 5: global weather-station ticker —
  attempt('wxstations', () => {
    const s = section(t('feature.wxstations'));
    dock.appendChild(s);
    return initWxstations({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.wxstations',`
`BASE_STRINGS` += `'feature.wxstations': 'Weather stations (global)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.wxstations': 'Station vitals'` |
| batcave | `'feature.wxstations': 'Weather station grid'` |
| garage | `'feature.wxstations': 'Weather stations'` |
| noir | `'feature.wxstations': 'Station reports'` |
| lcars | `'feature.wxstations': 'Planetary station net'` |
| pipboy | `'feature.wxstations': 'Weather stations'` |
| jarvis | `'feature.wxstations': 'Station telemetry'` |
| nerv | `'feature.wxstations': 'Station pattern'` |
| nightcity | `'feature.wxstations': 'Station feed'` |
| apollo | `'feature.wxstations': 'Station watch'` |
| weyland | `'feature.wxstations': 'Station log'` |
| synthwave | `'feature.wxstations': 'Weather stations'` |
| scp | `'feature.wxstations': 'Station file'` |
| tron | `'feature.wxstations': 'Station program'` |

## API contract

`GET /api/wxstations` →
`{ schemaVersion:1, generatedAt, count, sources:[{id,name,kind,status,count,error?}],
   stations:[{source,id,name,lat,lon,tempC,windMs,windDirDeg,rhPct,pressureHpa,
   timeMs,kind,coordApprox}], stale, unavailable, reason, attribution }`
- Cache 10 min, stale 45 min, retry cooldown 60 s, per-source timeout 20 s
  (raised from 12 s after 2026-09-27 ~16:00 EDT: several EU hosts showed
  transient 30 s connection failures while US hosts stayed fast — the
  per-source fail-soft path handled it honestly).
- `kind`: `obs` | `forecast` (MET Norway) | `station-index` (IPMA, no temps).

## Physics-honesty note (shown in the dock legend)
> MET Norway = forecast; IPMA = locations only; centroid-pinned stations are
> approximate. Sources: NWS, MET Norway, SMHI, HKO, NEA, IPMA, IMGW,
> Met Éireann, IMO.

## Conventions noted
- `redirect:'follow'` — workerd rejects `redirect:'error'` (established by the
  2026-09-27 edge incident; see nwsAlerts.js/fireballs.js headers).
- Wind-unit assumptions (INFERRED, flagged here): IMGW synop wind = m/s
  (Polish synop convention); Met Éireann obs wind = km/h (metweb.ie
  convention) → converted to m/s. If a source's unit turns out wrong, fix the
  single parser line — the row shape is unchanged.
- HKO/IMGW/Éireann/IMO carry `coordApprox:true` — no coordinates upstream.

## Verification
- Live sweep via stubbed-fetch tests + direct curl probes of all 9 upstreams
  (2026-09-27 ~15:45 EDT). NWS station set KROA/KJFK/KSEA/KBOS all HTTP 200
  (User-Agent sent). MET Norway requires UA — sent.
- Tests: `node --test server/providers/wave5/wxstations.test.mjs
  src/frontier/wave5/wxstations/wxstations.test.mjs` → 22/22 pass.
