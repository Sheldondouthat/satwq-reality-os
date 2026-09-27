# INTEGRATION — Wave 5 Track A: volcano alert ticker (GeoNet VAL + AVO)

**Status:** built 2026-09-27 · sources VERIFIED live (GeoNet 12 NZ volcanoes incl. White Island Yellow/2 + Ruapehu Yellow/1; AVO front page: Great Sitkin WATCH/ORANGE, Shishaldin ADVISORY/YELLOW → 4 elevated total)
**Files (mine only):**
- `server/providers/wave5/volcano.js` — `volcanoProxy()` factory → `/api/volcano`
- `server/providers/wave5/volcano.test.mjs` — 9 tests, all passing
- `api/volcano.js` — Vercel mount via `mountProvider`
- `src/frontier/wave5/volcano/model.js` — pure client model (level colors, ticker rank)
- `src/frontier/wave5/volcano/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave5/volcano/volcano.test.mjs` — 5 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { volcanoProxy } from './wave5/volcano.js';
```

`localProviderPlugins()` array — apply CONFLICT RULE below before choosing the spot:
```js
    volcanoProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` (pure fetch — Pages-safe):
```js
  {
    name: 'volcano',
    routes: ['/api/volcano'],
    load: () => import('../providers/wave5/volcano.js').then((m) => m.volcanoProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initVolcano } from './wave5/volcano/index.js';
```

Inside `initFrontier` (near the other hazard features):
```js
  // — W5 volcano alert ticker (GeoNet + AVO) —
  attempt('volcano', () => {
    const s = section(t('feature.volcano'));
    dock.appendChild(s);
    return initVolcano({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.volcano',`
`BASE_STRINGS` += `'feature.volcano': 'Volcano alerts (GeoNet + AVO)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.volcano': 'Volcano watch'` |
| batcave | `'feature.volcano': 'Volcano watch'` |
| garage | `'feature.volcano': 'Volcano alerts'` |
| noir | `'feature.volcano': 'Volcano dossier'` |
| lcars | `'feature.volcano': 'Volcano track'` |
| pipboy | `'feature.volcano': 'Volcano alerts'` |
| jarvis | `'feature.volcano': 'Volcano track'` |
| nerv | `'feature.volcano': 'Volcano pattern'` |
| nightcity | `'feature.volcano': 'Volcano feed'` |
| apollo | `'feature.volcano': 'Volcano watch'` |
| weyland | `'feature.volcano': 'Volcano log'` |
| synthwave | `'feature.volcano': 'Volcano alerts'` |
| scp | `'feature.volcano': 'Volcano file'` |
| tron | `'feature.volcano': 'Volcano program'` |

## CONFLICT RULE (concurrent wave5 agents)
Other Wave-A subagents may be adding `wave5/` providers in the same session (a `satnogs` directory was OBSERVED in `src/frontier/wave5/` during this build). Before applying §1–§3: re-read the target regions of `local.js`, `registry.mjs`, and `src/frontier/index.js` and merge at the end of the wave5 block — never duplicate an import, plugin entry, registry entry, or mount call.

## API contract

`GET /api/volcano`
→ `{ generatedAt, geonet:{status, count, volcanoes}, avo:{status, count, volcanoes, coverageNote},
    activeCount, active:[...], warnings:[...], sources:{geonet, avo},
    source:'GeoNet VAL (GNS Science, NZ) + AVO front page (USGS/UAF, Alaska) — keyless' }`
- `geonet.volcanoes[]`: `{id, name, lon, lat, level, color, activity, hazards}` — all NZ VAL entries incl. Green.
- `avo.volcanoes[]`: `{id, name, lat, lon, alertLevel, colorCode, region:'Alaska', url}` — **elevated-alert cards only** (front page).
- `active[]`: merged elevated list `{id, name, lon, lat, level, levelText, color, region, source}` sorted by color severity.
- A single upstream failure degrades to `status:'error'` + a `warnings[]` entry — the other source still serves. Never fabricated.

## Client honesty note (shown in the dock legend)
> NZ feed: GeoNet VAL (GNS Science). Alaska feed: AVO front page — elevated alerts only. Quiet here ≠ global all-clear.

## Verification
- Live: `https://api.geonet.org.nz/volcano/val` → HTTP 200, 12 volcanoes;
  `https://avo.alaska.edu/` → HTTP 200, parser captures Great Sitkin WATCH/ORANGE + Shishaldin ADVISORY/YELLOW (2026-09-27).
- Tests: `node --test server/providers/wave5/volcano.test.mjs src/frontier/wave5/volcano/volcano.test.mjs` → 14/14 pass.
- Module smoke: merged handler returns 200, 4 elevated, `warnings:[]`, via node import.
