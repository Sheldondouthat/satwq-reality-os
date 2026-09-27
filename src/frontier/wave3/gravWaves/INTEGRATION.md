# Spacetime ripples — Integration Guide

New files (this directory + server provider, created 2026-09-27):

| File | Contents |
|---|---|
| `src/frontier/wave3/gravWaves/index.js` | `init({viewer, dock})` — dock chip "◉ Ripples" opening a full-screen SKY overlay (seeded starfield canvas + event cards with source-classification bars + GraceDB links). Pure helpers: `badgeFor`, `classificationBars`, `formatGraceTime`. |
| `src/frontier/wave3/gravWaves/gravWaves.test.mjs` | 8 tests, node:test — real GraceDB notice assertions + middleware shape tests. |
| `server/providers/wave3/gracedb.js` | `gracedbProxy()` — `/api/gravwaves`. Zero imports (Pages-safe). |

No existing file was modified. No new npm deps, no keys, no WASM, no node: imports.

## 1. server/providers/local.js

Add the import (same block as the other wave3 entries):

```js
import { gracedbProxy } from './wave3/gracedb.js';
```

Add the plugin entry — insert after `neoProxy(),` inside `localProviderPlugins()`:

```js
    neoProxy(),
    gracedbProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion — Pages-eligible by design (keyless, zero-import module graph,
plain fetch, capped reads; verified loading in isolation via dynamic import).
Append before the closing `];` of REGISTRY:

```js
  {
    name: 'gravwaves',
    routes: ['/api/gravwaves'],
    load: () => import('../providers/wave3/gracedb.js').then((m) => m.gracedbProxy()),
  },
```

## 3. src/frontier/index.js — mount call

Add the import at the top:

```js
import { init as initGravWaves } from './wave3/gravWaves/index.js';
```

Add inside `initFrontier`, after the eyes-on `attempt(…)` block:

```js
  // — Wave 3: spacetime ripples (sky overlay, never the globe) —
  attempt('grav-waves', () => {
    const cleanup = initGravWaves({ viewer, dock });
    return typeof cleanup === 'function' ? cleanup : () => {};
  });
```

## 4. Theme dictionary strings

The module calls `t('feature.gravWaves')` for its dock section title.
Register in `src/themes/engine.js`: add `'feature.gravWaves',` to the key list
and to `BASE_STRINGS`:

```js
'feature.gravWaves': 'Spacetime ripples',
```

Add one `strings` entry per manifest in `src/themes/themes.js`, e.g.:

| Theme flavor | Suggested string |
|---|---|
| neutral/default | `Spacetime ripples` |
| medbay | `Deep-field tremors` |
| tactical/ops | `GW alert board` |

Also add the key to `src/themes/KEYS.md` if it enumerates feature keys.

## API contract — GET /api/gravwaves

```json
{
  "schemaVersion": 1,
  "fetchedAt": "2026-09-27T…Z",
  "source": "GraceDB public superevent API (keyless)",
  "displayNote": "Gravitational-wave events are distant cosmic events — shown on a SKY overlay…",
  "totalListed": 100,
  "productionInView": 0,
  "events": [
    { "id": "MS260927f",
      "category": "MDC",
      "categoryNote": "MOCK DATA CHALLENGE — injected test signal for pipeline validation, not a real detection",
      "createdUtc": "2026-09-27 05:28:50 UTC",
      "t0Gps": 1474521715.568255,
      "farHz": 9.11e-14,
      "farDescription": "1 per ~347800 years",
      "searchGroup": "CBC", "pipeline": "gstlal", "instruments": "H1,L1",
      "labels": ["EM_READY", "ADVOK", …],
      "classification": { "BNS": 0.9999969, "NSBH": 0, "BBH": 0, "Terrestrial": 3.1e-06 },
      "classificationNote": "source-class probabilities from the public GCN notice (model output, not a confirmed source type)",
      "gracedbUrl": "https://gracedb.ligo.org/superevents/MS260927f/view/" }
  ]
}
```

Cache: 30 min in-memory, `Cache-Control: public, max-age=600`. Upstream failure →
`502 {error:'gravwaves_upstream_unavailable'}`.

## Physics-honesty notes (for reviewers)

- Category is shown truthfully: MDC/Test = MOCK pipeline injections, NOT real
  detections; only `Production` = real public alert. Verified 2026-09-27 that
  the anonymous GraceDB endpoint ignores filter/pagination params and the
  current 100-event window contains zero Production events — the provider
  sorts Production first and reports `productionInView` rather than hiding
  the mock stream.
- Classification probabilities are MODEL OUTPUT from the public GCN notice
  where published, labeled as such — never presented as confirmed source types.
- Markers sit on a SKY overlay arranged as a detection timeline; card and
  overlay copy state explicitly that horizontal position is NOT sky position
  (multi-order FITS skymaps are not parsed). Nothing is plotted on the Earth globe.
