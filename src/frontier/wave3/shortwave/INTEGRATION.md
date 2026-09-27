# INTEGRATION — Wave 3 Track 3b.9: EiBi + WSPR shortwave oracle

**Status:** built 2026-09-27 · all four inputs VERIFIED live (EiBi 400 on-air,
800 WSPR spots, F10.7=101, Kp=0 → MUF 15.9/8.0 MHz, best band 75m "fair")
**Files (mine only):**
- `server/providers/wave3/shortwave.js` — `shortwaveOracleProxy()` →
  `/api/shortwave-oracle`. Composes same-origin `/api/eibi` +
  `/api/invisible-ocean/spots` (already cached by their owners — nothing is
  scraped twice) plus direct SWPC 10cm-flux + 1-min Kp. No `node:` imports,
  no WASM — Pages-safe. Does NOT import or edit any other worker's module.
- `server/providers/wave3/shortwave.test.mjs` — 14 tests, all passing.
- `src/frontier/wave3/shortwave/model.js` — pure client helpers.
- `src/frontier/wave3/shortwave/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave3/shortwave/shortwave.test.mjs` — 4 tests, all passing.

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { shortwaveOracleProxy } from './wave3/shortwave.js';
```

`localProviderPlugins()` array (near the other wave3 proxies):
```js
    shortwaveOracleProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'shortwave-oracle',
    routes: ['/api/shortwave-oracle'],
    load: () => import('../providers/wave3/shortwave.js').then((m) => m.shortwaveOracleProxy()),
  },
```

> NOTE: the oracle fetches `/api/eibi` and `/api/invisible-ocean/spots`
> same-origin. `invisible-ocean` is already registered; `eibi` is currently
> only in `local.js` (dev). If `eibi` is not added to the Pages registry,
> the oracle still serves — its EiBi component degrades to "unknown" and the
> `upstream.eibi` field says why. No change needed in this worker's files.

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initShortwave } from './wave3/shortwave/index.js';
```

Inside `initFrontier`, after the infrasound attempt block:
```js
  // — W3 3b.9 shortwave oracle —
  attempt('shortwave', () => {
    const s = section(t('feature.shortwave'));
    dock.appendChild(s);
    return initShortwave({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.shortwave',`
`BASE_STRINGS` += `'feature.shortwave': 'Shortwave oracle',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.shortwave': 'Propagation oracle'` |
| batcave | `'feature.shortwave': 'Propagation oracle'` |
| garage | `'feature.shortwave': 'Shortwave oracle'` |
| noir | `'feature.shortwave': 'Signal dossier'` |
| lcars | `'feature.shortwave': 'Propagation scan'` |
| pipboy | `'feature.shortwave': 'Shortwave oracle'` |
| jarvis | `'feature.shortwave': 'Band conditions'` |
| nerv | `'feature.shortwave': 'Propagation pattern'` |
| nightcity | `'feature.shortwave': 'Band feed'` |
| apollo | `'feature.shortwave': 'Propagation oracle'` |
| weyland | `'feature.shortwave': 'Propagation log'` |
| synthwave | `'feature.shortwave': 'Shortwave oracle'` |
| scp | `'feature.shortwave': 'Propagation file'` |
| tron | `'feature.shortwave': 'Propagation program'` |

## API contract

`GET /api/shortwave-oracle`
→ `{ generatedAt, solar:{flux10cm,kp}, muf:{dayMufMhz,nightMufMhz,model},
    bands:[...], bestBand, sources, upstream, cachedAt, honesty }`
- band: `{band, kind, rangeMhz, wsprSpots30m, wsprMedianSnrDb, eibiOnAir,
  eibiExample, score, components:{measured,scheduled,sky}, verdict}`
- `score` 0..100 or null; every verdict ends in "(model)" or is "no data".
- `upstream`: per-input `ok` | error string — each input degrades independently.
- EiBi provider by another worker (`server/providers/wave3/eibi.js`,
  `src/frontier/wave3/eibi/`) was NOT duplicated; the oracle only reads its
  HTTP API. WSPR spots likewise come from the existing invisible-ocean route.

## Physics-honesty note (shown in the dock legend)
> Scores = heuristic model: 50% measured WSPR activity, 20% EiBi schedule,
> 30% solar/day-night rule. Not measured reception at your location. MUF =
> rough empirical estimate (foF2≈2.2+0.026×F10.7, M-factor 3.3), not an ionosonde.

## Verification
- Live 2026-09-27 ~06:05 UTC: eibi ok (400 on-air), spots ok (800),
  flux ok (101), kp ok (0) → MUF 15.9/8.0 MHz; best band 75m score 65
  "fair (model)" — sensible for night-time US (low bands favored).
- `Number(null)===0` class bug caught during build: `solar.flux10cm` would
  have read 0 instead of null when SWPC was down — fixed with null-safe
  coercion, regression-tested.
- Tests: `node --test server/providers/wave3/shortwave.test.mjs` → 14/14;
  `node --test src/frontier/wave3/shortwave/shortwave.test.mjs` → 4/4.
