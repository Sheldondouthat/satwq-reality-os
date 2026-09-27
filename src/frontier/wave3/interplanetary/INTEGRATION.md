# Interplanetary layer — Integration Guide

New files (this directory + server provider, created 2026-09-27):

| File | Contents |
|---|---|
| `src/frontier/wave3/interplanetary/index.js` | `init({viewer, dock})` — dock chip "🛰 Deep space" opening a full-screen log-distance "beyond" view (canvas polar chart + mission table). Pure helpers: `logRadius01`, `eclipticAngleRad`, `formatDistance`, `formatLightTime`. |
| `src/frontier/wave3/interplanetary/interplanetary.test.mjs` | 10 tests, node:test — real JPL Horizons data assertions + middleware smoke tests. |
| `server/providers/wave3/interplanetary.js` | `interplanetaryProxy()` — `/api/interplanetary`. Zero imports (Pages-safe). |

No existing file was modified. No new npm deps, no keys, no WASM, no node: imports.

## 1. server/providers/local.js

Add the import (after the vaac import line):

```js
import { vaacProxy } from './vaac.js';
import { interplanetaryProxy } from './wave3/interplanetary.js';
import { neoProxy } from './wave3/neo.js';
import { gracedbProxy } from './wave3/gracedb.js';
```

Add the plugin entry — insert after `vaacProxy(),` inside `localProviderPlugins()`:

```js
    vaacProxy(),
    interplanetaryProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion — this provider is Pages-eligible by design (keyless, zero-import
module graph, plain fetch, capped reads; verified loading in isolation via
dynamic import). Append before the closing `];` of REGISTRY:

```js
  {
    name: 'interplanetary',
    routes: ['/api/interplanetary'],
    load: () => import('../providers/wave3/interplanetary.js').then((m) => m.interplanetaryProxy()),
  },
```

## 3. src/frontier/index.js — mount call

Add the import at the top:

```js
import { init as initInterplanetary } from './wave3/interplanetary/index.js';
```

Add inside `initFrontier`, after the briefing `attempt('briefing', …)` block:

```js
  // — Wave 3: interplanetary "beyond" view —
  attempt('interplanetary', () => {
    const cleanup = initInterplanetary({ viewer, dock });
    return typeof cleanup === 'function' ? cleanup : () => {};
  });
```

`dock` here is the `const dock = createDock();` body element already in scope.

## 4. Theme dictionary strings

The module calls `t('feature.interplanetary')` for its dock section title.
Register in `src/themes/engine.js`: add `'feature.interplanetary',` to the key
list (after `'feature.autoBriefing',`) and to `BASE_STRINGS`:

```js
'feature.interplanetary': 'Interplanetary',
```

Add one `strings` entry per manifest in `src/themes/themes.js`, e.g.:

| Theme flavor | Suggested string |
|---|---|
| neutral/default | `Interplanetary` |
| medbay | `Deep-space telemetry` |
| tactical/ops | `Deep-space board` |

Also add the key to `src/themes/KEYS.md` if it enumerates feature keys.

## API contract — GET /api/interplanetary

```json
{
  "schemaVersion": 1,
  "fetchedAt": "2026-09-27T…Z",
  "source": "JPL Horizons API (keyless)",
  "frameNote": "Positions are solar-system-barycentric ecliptic J2000…",
  "craft": [
    { "id": "vgr1", "name": "Voyager 1", "blurb": "…",
      "epoch": "2026-09-27 00:00 TDB",
      "xKm": -4.81e9, "yKm": -2.04e10, "zKm": 1.48e10,
      "distAu": 171.9, "speedKms": 16.9, "lightTimeHrs": 23.8,
      "frame": "solar-system-barycentric ecliptic J2000 (JPL Horizons)" }
  ],
  "failed": []
}
```

Cache: 1 h in-memory, `Cache-Control: public, max-age=600`. Upstream failure →
`502 {error:'interplanetary_upstream_unavailable'}`.

## Physics-honesty notes (for reviewers)

- Positions are REAL (JPL Horizons VECTOR ephemeris, barycentric ecliptic
  J2000) — verified live 2026-09-27 (Voyager 1 at 171.9 AU, 23.8 light-hours).
- The view is a DEDICATED log-distance chart (0.2–250 AU, rings labeled in AU).
  The Earth globe is never rescaled. The log compression is labeled on the
  chart itself.
