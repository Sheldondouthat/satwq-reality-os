# INTEGRATION — Wave 5 research ticker (item 17)

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

The wave5 imports are covered by the civic INTEGRATION.md block; if
applied there, this step is already done. Otherwise:

```js
import { civicProxy } from './wave5/civic.js';
import { researchProxy } from './wave5/research.js';
import { biosphereProxy } from './wave5/biosphere.js';
```

```js
    reentriesProxy(),
    civicProxy(),
    researchProxy(),
    biosphereProxy(),
    keySetupEndpoint(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM). Add after the `water-twin` entry (and after the `civic` entry if
applied), before the closing `];`:

```js
  {
    name: 'research',
    routes: ['/api/research'],
    load: () => import('../providers/wave5/research.js').then((m) => m.researchProxy()),
  },
```

## 3. src/frontier/index.js

Add the import at the top (with the other feature imports):

```js
import { init as initResearch } from './wave5/research/index.js';
```

Add the mount inside `initFrontier`, after the civic block and before the
`// — Wave 3 Track 1a: cable-threat correlation —` block:

```js
  // — Wave 5: research ticker —
  attempt('research', () => {
    const s = section(t('feature.research'));
    dock.appendChild(s);
    return initResearch({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js` (after `'feature.terminatorRush',`):

```js
  'feature.research',
```

Add to `BASE_STRINGS` in `engine.js` (after `'feature.terminatorRush': 'Terminator Rush',`):

```js
  'feature.research': 'Research ticker',
```

Add to every theme dictionary in `themes.js` (after each
`'feature.terminatorRush': "Terminator Rush",` line — 14 themes):

```js
      'feature.research': "Research ticker",
```

## Files owned by this feature (do not move)

- `server/providers/wave5/research.js` — provider factory (`researchProxy`),
  mounts `/api/research`, 30-min cache, merges OpenAlex + Crossref + PubMed
  (esearch→esummary) + arXiv (Atom, hand-rolled parse, mandatory 3 s pacing
  via `paceArxiv()`), dedupes by normalized DOI (title fallback), partial
  failure → `degradedSources`, all-source failure → 502.
- `server/providers/wave5/research.test.mjs` — 12 tests (fetch-mocked,
  asserts `redirect:'error'`, DOI/title dedupe).
- `src/frontier/wave5/research/model.js` — feed labels/glyphs, authorLine,
  pubYear, workSubtitle (pure).
- `src/frontier/wave5/research/index.js` — dock ticker mount (`init`),
  hourly refresh, chip toggle via trackLayer.
- `src/frontier/wave5/research/research.test.mjs` — 6 tests (pure model).
