# INTEGRATION — Wave 5: POTA "who's on the air" (api.pota.app, keyless)

**Status:** built 2026-09-27 · all inputs VERIFIED live
(spot feed: live spots with mode/freq; park endpoint: US-0716 → 34.9405, -85.2598)
**Files (mine only):**
- `server/providers/wave5/pota.js` — `potaProxy()` → `/api/pota`
- `server/providers/wave5/pota.test.mjs` — 12 tests, all passing
- `api/pota.js` — Vercel mount via `mountProvider`
- `src/frontier/wave5/pota/model.js` — pure client helpers (mode colors, band labels, age)
- `src/frontier/wave5/pota/index.js` — `init({viewer, mount, chip, trackLayer, t})` globe points
- `src/frontier/wave5/pota/pota.test.mjs` — 6 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block (after the donki import):
```js
import { potaProxy } from './wave5/pota.js';
```

`localProviderPlugins()` array, after `donkiProxy(),`:
```js
    donkiProxy(),
    potaProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` after the `donki` entry (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'pota',
    routes: ['/api/pota'],
    load: () => import('../providers/wave5/pota.js').then((m) => m.potaProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block (after the donki import):
```js
import { init as initPota } from './wave5/pota/index.js';
```

Inside `initFrontier`, after the `reentry` attempt block (the last one, before `return {`):
```js
  // — Wave 5: POTA who's on the air —
  attempt('pota', () => {
    const s = section(t('feature.pota'));
    dock.appendChild(s);
    return initPota({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` (after `'feature.donki',`):
```js
  'feature.pota',
```
`BASE_STRINGS` (after `'feature.donki': 'Solar storms (DONKI)',`):
```js
  'feature.pota': "Who's on the air (POTA)",
```

`src/themes/themes.js` — in each theme's `strings` block, after the
`'feature.donki': "Solar storms (DONKI)",` line:
| theme | string |
|---|---|
| medbay | `'feature.pota': "Who's on the air"` |
| batcave | `'feature.pota': "Who's on the air"` |
| garage | `'feature.pota': "Who's on the air (POTA)"` |
| noir | `'feature.pota': "Airwave dossier"` |
| lcars | `'feature.pota': "Active parks scan"` |
| pipboy | `'feature.pota': "Who's on the air (POTA)"` |
| jarvis | `'feature.pota': "Park activations"` |
| nerv | `'feature.pota': "Activation pattern"` |
| nightcity | `'feature.pota': "Airwave feed"` |
| apollo | `'feature.pota': "Park activations"` |
| weyland | `'feature.pota': "Activation log"` |
| synthwave | `'feature.pota': "Who's on the air"` |
| scp | `'feature.pota': "Activation file"` |
| tron | `'feature.pota': "On-air program"` |

## API contract

`GET /api/pota?limit=200&mode=FT8` (limit 1–500, default 200; mode optional case-insensitive)
→ `{ generatedAt, count, withCoords, spots:[{spotId, spotTime, activator,
frequencyKhz, mode, reference, name, locationDesc, spotter, source, lat, lon}],
source, honesty }`
- Spots without a park coordinate still ship (lat/lon null) — the globe only plots `withCoords`.
- Park lookups cached 24 h; dead refs cached as null for 5 min (a retired ref can't stampede the upstream).
- `honesty`: spots are live self/spotter reports; park coords are the registered park location (may lag new refs).

## Physics-honesty note (shown in the dock legend)
> Live spots via api.pota.app; park coords = registered location (may lag new refs).

## Verification
- Live 2026-09-27 ~15:40 EDT: `/spot/` → HTTP 200, live spots (e.g. IU4SQE FT8 7074.0 IT-1136);
  `/park/US-0716` → `{"latitude": 34.9405, "longitude": -85.2598}` — join path works.
  **VERIFIED.**
- `Number(null)===0` class bug caught during build: null lat/lon/ids passed
  `Number.isFinite(Number(x))` checks as 0 — fixed with a `numOrNull` helper
  (same class as the 2026-09-27 shortwave lesson). Regression-tested.
- Tests: `node --test server/providers/wave5/pota.test.mjs` → 12/12;
  `node --test src/frontier/wave5/pota/pota.test.mjs` → 6/6.
- Redirect note: `redirect:'follow'` + final-host pinning to `api.pota.app`
  (workerd rejects `redirect:'error'` — the 2026-09-27 edge incident).
