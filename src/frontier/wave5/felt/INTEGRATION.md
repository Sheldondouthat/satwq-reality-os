# INTEGRATION — Wave 5 Track A: EMSC felt earthquakes (crowd-sourced)

**Status:** built 2026-09-27 · source VERIFIED live (16 felt events / 282 testimonies, rolling 72h; top = M3.5 Torrance, 42 testimonies)
**Files (mine only):**
- `server/providers/wave5/felt.js` — `feltProxy()` factory → `/api/felt`
- `server/providers/wave5/felt.test.mjs` — 7 tests, all passing
- `api/felt.js` — Vercel mount via `mountProvider`
- `src/frontier/wave5/felt/model.js` — pure client model (testimony size, mag color, age)
- `src/frontier/wave5/felt/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave5/felt/felt.test.mjs` — 5 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block (next to the other wave5 imports, or after the wave3 block):
```js
import { feltProxy } from './wave5/felt.js';
```

`localProviderPlugins()` array — apply CONFLICT RULE below before choosing the spot:
```js
    feltProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'felt',
    routes: ['/api/felt'],
    load: () => import('../providers/wave5/felt.js').then((m) => m.feltProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initFelt } from './wave5/felt/index.js';
```

Inside `initFrontier` (near the other hazard features, e.g. after the sigmets block):
```js
  // — W5 felt earthquakes (EMSC crowd-sourced) —
  attempt('felt', () => {
    const s = section(t('feature.felt'));
    dock.appendChild(s);
    return initFelt({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.felt',`
`BASE_STRINGS` += `'feature.felt': 'Felt earthquakes (EMSC)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.felt': 'Felt-shaking monitor'` |
| batcave | `'feature.felt': 'Felt-shaking monitor'` |
| garage | `'feature.felt': 'Felt earthquakes'` |
| noir | `'feature.felt': 'Felt-shaking dossier'` |
| lcars | `'feature.felt': 'Felt-quake track'` |
| pipboy | `'feature.felt': 'Felt earthquakes'` |
| jarvis | `'feature.felt': 'Felt-shaking track'` |
| nerv | `'feature.felt': 'Felt-shaking pattern'` |
| nightcity | `'feature.felt': 'Felt-quake feed'` |
| apollo | `'feature.felt': 'Felt-shaking watch'` |
| weyland | `'feature.felt': 'Felt-shaking log'` |
| synthwave | `'feature.felt': 'Felt earthquakes'` |
| scp | `'feature.felt': 'Felt-shaking file'` |
| tron | `'feature.felt': 'Felt-shaking program'` |

## CONFLICT RULE (concurrent wave5 agents)
Other Wave-A subagents may also be adding `wave5/` providers in the same session (a `satnogs` directory was OBSERVED in `src/frontier/wave5/` during this build). Before applying §1–§3: re-read the target regions of `local.js`, `registry.mjs`, and `src/frontier/index.js` and merge at the end of the wave5 block — never duplicate an import, plugin entry, registry entry, or mount call.

## API contract

`GET /api/felt`
→ `{ generatedAt, count, totalTestimonies, events:[...], window:'rolling 72h',
    source:'EMSC felt-earthquake feed (crowd-sourced testimonies, keyless)' }`
- Event: `{id, name, mag, depthKm, lon, lat, timeMs, timeISO,
  testimonyCount, feltReportCount, mediaCount, url}` — sorted desc by `testimonyCount`.

## Client honesty note (shown in the dock legend)
> Point size = testimony volume (crowd-sourced). Color = magnitude. Testimonies are self-reported, not instrumental intensity. Source: EMSC.

## Verification
- Live: `https://www.emsc-csem.org/Tools/api/felt/felt_quakes.geojson.php`
  → HTTP 200, 16 events, 282 testimonies (2026-09-27 ~19:44 UTC).
- Tests: `node --test server/providers/wave5/felt.test.mjs src/frontier/wave5/felt/felt.test.mjs` → 12/12 pass.
- Module smoke: provider handler returns 200 with live counts via node import.
