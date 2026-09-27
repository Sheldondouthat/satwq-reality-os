# INTEGRATION — Wave 5 Track A: GDACS multi-hazard events

**Status:** built 2026-09-27 · source VERIFIED live (92 events: EQ 24, FL 21, TC 19, WF 15, VO 6, DR 7; 2 live episodes, incl. Orange TC POLO-26 off Mexico)
**Files (mine only):**
- `server/providers/wave5/hazards.js` — `hazardsProxy()` factory → `/api/hazards`
- `server/providers/wave5/hazards.test.mjs` — 7 tests, all passing
- `api/hazards.js` — Vercel mount via `mountProvider`
- `src/frontier/wave5/hazards/model.js` — pure client model (type colors/glyphs, ranking)
- `src/frontier/wave5/hazards/index.js` — `init({viewer, mount, chip, trackLayer, t})`
- `src/frontier/wave5/hazards/hazards.test.mjs` — 5 tests, all passing

## 1. `server/providers/local.js` — exact lines

Import block:
```js
import { hazardsProxy } from './wave5/hazards.js';
```

`localProviderPlugins()` array — apply CONFLICT RULE below before choosing the spot:
```js
    hazardsProxy(),
```

## 2. `server/pages/registry.mjs` — exact lines

Append to `REGISTRY` (pure fetch/JSON — Pages-safe):
```js
  {
    name: 'hazards',
    routes: ['/api/hazards'],
    load: () => import('../providers/wave5/hazards.js').then((m) => m.hazardsProxy()),
  },
```

## 3. `src/frontier/index.js` — exact mount call

Import block:
```js
import { init as initHazards } from './wave5/hazards/index.js';
```

Inside `initFrontier` (near the other hazard features):
```js
  // — W5 GDACS multi-hazard events —
  attempt('hazards', () => {
    const s = section(t('feature.hazards'));
    dock.appendChild(s);
    return initHazards({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme dictionary strings

`src/themes/engine.js` — `REQUIRED_KEYS` += `'feature.hazards',`
`BASE_STRINGS` += `'feature.hazards': 'Multi-hazard events (GDACS)',`

`src/themes/themes.js` per-theme strings:
| theme | string |
|---|---|
| medbay | `'feature.hazards': 'Hazard board'` |
| batcave | `'feature.hazards': 'Hazard board'` |
| garage | `'feature.hazards': 'Multi-hazard events'` |
| noir | `'feature.hazards': 'Hazard dossier'` |
| lcars | `'feature.hazards': 'Hazard track'` |
| pipboy | `'feature.hazards': 'Multi-hazard events'` |
| jarvis | `'feature.hazards': 'Hazard track'` |
| nerv | `'feature.hazards': 'Hazard pattern'` |
| nightcity | `'feature.hazards': 'Hazard feed'` |
| apollo | `'feature.hazards': 'Hazard watch'` |
| weyland | `'feature.hazards': 'Hazard log'` |
| synthwave | `'feature.hazards': 'Multi-hazard events'` |
| scp | `'feature.hazards': 'Hazard file'` |
| tron | `'feature.hazards': 'Hazard program'` |

## CONFLICT RULE (concurrent wave5 agents)
Other Wave-A subagents may be adding `wave5/` providers in the same session (a `satnogs` directory was OBSERVED in `src/frontier/wave5/` during this build). Before applying §1–§3: re-read the target regions of `local.js`, `registry.mjs`, and `src/frontier/index.js` and merge at the end of the wave5 block — never duplicate an import, plugin entry, registry entry, or mount call.

## API contract

`GET /api/hazards`
→ `{ generatedAt, count, currentCount, byType, events:[...],
    source:'GDACS (EU Joint Research Centre, keyless multi-hazard feed)' }`
- Event: `{eventtype, eventid, episodeid, name, lon, lat, alertlevel, alertscore,
  country, iso3, fromdate, todate, datemodified, severityText, iscurrent,
  reportUrl, detailUrl, source}` — sorted Red > Orange, then JRC alertscore.
- `eventtype` ∈ EQ|FL|TC|WF|VO|DR|OTHER.

## Client honesty note (shown in the dock legend)
> Alert levels are GDACS/JRC analyst severity scores, not local impact predictions. Source: GDACS.

## Verification
- Live: `https://gdacs.org/gdacsapi/api/events/geteventlist/SEARCH`
  → HTTP 200, ~130 KB, 92 events incl. Orange TC POLO-26 (Mexico), 2 live episodes (2026-09-27).
- Tests: `node --test server/providers/wave5/hazards.test.mjs src/frontier/wave5/hazards/hazards.test.mjs` → 12/12 pass.
- Module smoke: provider handler returns 200 with live counts via node import.
