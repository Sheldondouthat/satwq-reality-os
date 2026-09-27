# Planetary defense board — Integration Guide

New files (this directory + server provider, created 2026-09-27):

| File | Contents |
|---|---|
| `src/frontier/wave3/planetaryDefense/index.js` | `init({viewer, dock})` — dock chip "☄ NEO board" toggling a table panel + Cesium globe markers (true-radius miss-distance rings + diameter-scaled spheres). Pure helpers: `sortByMissDistance`, `tintForLd`, `formatLd`, `formatDiameter`. |
| `src/frontier/wave3/planetaryDefense/planetaryDefense.test.mjs` | 9 tests, node:test — real CNEOS data assertions + middleware smoke tests. |
| `server/providers/wave3/neo.js` | `neoProxy()` — `/api/neo`. Zero imports (Pages-safe). |

No existing file was modified. No new npm deps, no keys, no WASM, no node: imports.

## 1. server/providers/local.js

Add the import (same block as the interplanetary entry):

```js
import { neoProxy } from './wave3/neo.js';
```

Add the plugin entry — insert after `interplanetaryProxy(),` inside `localProviderPlugins()`:

```js
    interplanetaryProxy(),
    neoProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion — Pages-eligible by design (keyless, zero-import module graph,
plain fetch, capped reads). Append before the closing `];` of REGISTRY:

```js
  {
    name: 'neo',
    routes: ['/api/neo'],
    load: () => import('../providers/wave3/neo.js').then((m) => m.neoProxy()),
  },
```

## 3. src/frontier/index.js — mount call

Add the import at the top:

```js
import { init as initPlanetaryDefense } from './wave3/planetaryDefense/index.js';
```

Add inside `initFrontier`, after the interplanetary `attempt(…)` block:

```js
  // — Wave 3: planetary defense board —
  attempt('planetary-defense', () => {
    const cleanup = initPlanetaryDefense({ viewer, dock });
    return typeof cleanup === 'function' ? cleanup : () => {};
  });
```

## 4. Theme dictionary strings

The module calls `t('feature.planetaryDefense')` for its dock section title.
Register in `src/themes/engine.js`: add `'feature.planetaryDefense',` to the key
list and to `BASE_STRINGS`:

```js
'feature.planetaryDefense': 'Planetary defense',
```

Add one `strings` entry per manifest in `src/themes/themes.js`, e.g.:

| Theme flavor | Suggested string |
|---|---|
| neutral/default | `Planetary defense` |
| medbay | `Impact triage` |
| tactical/ops | `NEO threat board` |

Also add the key to `src/themes/KEYS.md` if it enumerates feature keys.

## API contract — GET /api/neo

```json
{
  "schemaVersion": 1,
  "fetchedAt": "2026-09-27T…Z",
  "source": "NASA/JPL CNEOS Close-Approach Data API (keyless)",
  "window": { "from": "2026-09-27", "to": "2026-10-04", "distMaxAu": 0.05 },
  "count": 12,
  "physicsNotes": ["Miss distances are geocentric close-approach distances…",
                   "Diameters are ESTIMATED from absolute magnitude H…"],
  "approaches": [
    { "des": "2026 SA8", "name": "(2026 SA8)",
      "closeApproachUtc": "2026-Sep-28 06:45",
      "distAu": 0.002539, "distLd": 0.988,
      "distMinLd": 0.975, "distMaxLd": 1.001,
      "vRelKms": 6.61, "absMagH": 28.634,
      "diameterEstM": { "loM": 4.99, "hiM": 11.15, "albedoAssumed": [0.05, 0.25] },
      "diameterNote": "ESTIMATED from absolute magnitude H assuming albedo 0.05–0.25 (albedo unknown)" }
  ]
}
```

Cache: 6 h in-memory, `Cache-Control: public, max-age=1800`. Upstream failure →
`502 {error:'neo_upstream_unavailable'}`.

## Physics-honesty notes (for reviewers)

- Miss distances are the API's geocentric close-approach values, in lunar
  distances (1 LD = 384,400 km). Sorted ascending; < 1 LD rows are highlighted
  as inside the Moon's orbit.
- Diameters are ESTIMATED from H with assumed albedo 0.05–0.25 — an
  order-of-magnitude guide, labeled as such in the table and API notes.
- Globe rings use the TRUE miss-distance radius (equatorial plane). Ring
  orientation is a display choice (the API publishes no approach geometry) and
  is labeled. Marker spheres are exaggerated ×1000 and labeled.
