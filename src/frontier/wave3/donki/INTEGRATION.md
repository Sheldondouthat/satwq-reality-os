# INTEGRATION — Wave 3 Track 2a.5: NASA DONKI (CCMC keyless)

**Status:** built 2026-09-27 · source VERIFIED live (CME endpoint: 135 events/31d; FLR 7d → `[]` legitimate empty)
**Files (mine only):**
- `server/providers/wave3/donki.js` — `donkiProxy()` factory → `/api/donki`
- `src/frontier/wave3/donki/model.js` — pure client model (subsolar point, arcs, countdown)
- `src/frontier/wave3/donki/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave3/donki/donki.test.mjs` — 16 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { donkiProxy } from './wave3/donki.js';
```

`localProviderPlugins()` array, after `swpcProxy(),`:
```js
    swpcProxy(),
    donkiProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `swpc` entry (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'donki',
    routes: ['/api/donki'],
    load: () => import('../providers/wave3/donki.js').then((m) => m.donkiProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initDonki } from './wave3/donki/index.js';
```

Inside `initFrontier`, after the space-weather attempt block:
```js
  // — W3 2.5 DONKI solar storms —
  attempt('donki', () => {
    const s = section(t('feature.donki'));
    dock.appendChild(s);
    return initDonki({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.donki',`
`BASE_STRINGS` += `'feature.donki': 'Solar storms (DONKI)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.donki': 'Solar storm watch'` |
| batcave | `'feature.donki': 'Solar storm watch'` |
| garage | `'feature.donki': 'Solar storms'` |
| noir | `'feature.donki': 'Solar storm dossier'` |
| lcars | `'feature.donki': 'Solar event track'` |
| pipboy | `'feature.donki': 'Solar storms'` |
| jarvis | `'feature.donki': 'Solar storm track'` |
| nerv | `'feature.donki': 'Solar storm pattern'` |
| nightcity | `'feature.donki': 'Solar storm feed'` |
| apollo | `'feature.donki': 'Solar storm watch'` |
| weyland | `'feature.donki': 'Solar event log'` |
| synthwave | `'feature.donki': 'Solar storms'` |
| scp | `'feature.donki': 'Solar event file'` |
| tron | `'feature.donki': 'Solar storm program'` |

## API contract

`GET /api/donki?type=CME&days=30` (type ∈ CME|FLR|GST|SEP; days 1–60)
→ `{ schemaVersion:1, type, days, etaModel, events:[...], fetchedAt, stale, ... }`
- CME events: `{id,startMs,sourceLocation,speedKms,halfAngleDeg,sourceLat,sourceLon,
  earthDirected,etaHours,etaMs,note,link}` — parsed from the most-accurate analysis.
- `earthDirected`: heuristic (disk-center source, halo/wide cone, or analyst note) —
  labeled a heuristic everywhere it renders.
- `etaMs`: **ballistic constant-speed model** (`etaModel` field + legend say so —
  a cinematic estimate, not a forecast).

## Physics-honesty note (shown in the dock legend)
> Earth-directed = heuristic; ETA = ballistic constant-speed model, not a forecast. Source: NASA DONKI.

## Verification
- Live: `kauai.ccmc.gsfc.nasa.gov/DONKI/WS/get/CME?startDate=2026-08-27&endDate=2026-09-27`
  → HTTP 200, 135 CMEs incl. full `cmeAnalyses`. **VERIFIED.** FLR 7-day window → `[]`
  (legitimate empty = no flares; endpoint reachable). Wide-range FLR probe hit a
  transient connection failure (http=000) — endpoint, not absence. **Use the CCMC
  path, never api.nasa.gov (keyed).**
- Tests: `node --test src/frontier/wave3/donki/donki.test.mjs` → 15/15 pass.
