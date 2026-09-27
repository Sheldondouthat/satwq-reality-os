# INTEGRATION — Wave 5 civic knowledge ticker (items 16)

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the imports (after the last wave3 import, `reentriesProxy`):

```js
import { civicProxy } from './wave5/civic.js';
import { researchProxy } from './wave5/research.js';
import { biosphereProxy } from './wave5/biosphere.js';
```

Add the proxies in `localProviderPlugins()`, immediately before `keySetupEndpoint()`:

```js
    reentriesProxy(),
    civicProxy(),
    researchProxy(),
    biosphereProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM — PAGES_PORT.md exclusion table does not cover it). Add after the
`water-twin` entry, before the closing `];`:

```js
  {
    name: 'civic',
    routes: ['/api/civic'],
    load: () => import('../providers/wave5/civic.js').then((m) => m.civicProxy()),
  },
```

## 3. src/frontier/index.js

Add the import at the top (with the other feature imports):

```js
import { init as initCivic } from './wave5/civic/index.js';
```

Add the mount inside `initFrontier`, after the `// — solar storms (NASA DONKI) —`
block and before the `// — Wave 3 Track 1a: cable-threat correlation —` block:

```js
  // — Wave 5: civic knowledge ticker —
  attempt('civic', () => {
    const s = section(t('feature.civic'));
    dock.appendChild(s);
    return initCivic({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js` (after `'feature.terminatorRush',`):

```js
  'feature.civic',
```

Add to `BASE_STRINGS` in `engine.js` (after `'feature.terminatorRush': 'Terminator Rush',`):

```js
  'feature.civic': 'Civic ticker',
```

Add to every theme dictionary in `themes.js` (after each
`'feature.terminatorRush': "Terminator Rush",` line — 14 themes):

```js
      'feature.civic': "Civic ticker",
```

## Files owned by this feature (do not move)

- `server/providers/wave5/civic.js` — provider factory (`civicProxy`),
  mounts `/api/civic`, 15-min cache, merges Federal Register + HN + NYC 311,
  partial failure → `degradedSources`, all-source failure → 502.
- `server/providers/wave5/civic.test.mjs` — 10 tests (fetch-mocked,
  asserts `redirect:'error'`).
- `src/frontier/wave5/civic/model.js` — feed labels/glyphs, timeAgo,
  itemSubtitle (pure).
- `src/frontier/wave5/civic/index.js` — dock ticker mount (`init`),
  30-min refresh, chip toggle via trackLayer.
- `src/frontier/wave5/civic/civic.test.mjs` — 5 tests (pure model).
