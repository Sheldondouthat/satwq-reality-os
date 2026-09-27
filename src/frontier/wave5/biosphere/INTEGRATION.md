# INTEGRATION — Wave 5 biosphere ticker (item 23)

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
WASM). Add after the `water-twin` entry (and after the civic/research
entries if applied), before the closing `];`:

```js
  {
    name: 'biosphere',
    routes: ['/api/biosphere'],
    load: () => import('../providers/wave5/biosphere.js').then((m) => m.biosphereProxy()),
  },
```

## 3. src/frontier/index.js

Add the import at the top (with the other feature imports):

```js
import { init as initBiosphere } from './wave5/biosphere/index.js';
```

Add the mount inside `initFrontier`, after the research block and before the
`// — Wave 3 Track 1a: cable-threat correlation —` block:

```js
  // — Wave 5: biosphere ticker —
  attempt('biosphere', () => {
    const s = section(t('feature.biosphere'));
    dock.appendChild(s);
    return initBiosphere({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js` (after `'feature.terminatorRush',`):

```js
  'feature.biosphere',
```

Add to `BASE_STRINGS` in `engine.js` (after `'feature.terminatorRush': 'Terminator Rush',`):

```js
  'feature.biosphere': 'Biosphere ticker',
```

Add to every theme dictionary in `themes.js` (after each
`'feature.terminatorRush': "Terminator Rush",` line — 14 themes):

```js
      'feature.biosphere': "Biosphere ticker",
```

## Files owned by this feature (do not move)

- `server/providers/wave5/biosphere.js` — provider factory
  (`biosphereProxy`), mounts `/api/biosphere`, 15-min cache, merges
  iNaturalist + GBIF, parses iNaturalist "lat,lon" strings, counts
  coord-bearing records as `withCoords`, partial failure → `degradedSources`,
  all-source failure → 502.
- `server/providers/wave5/biosphere.test.mjs` — 9 tests (fetch-mocked,
  asserts `redirect:'error'`).
- `src/frontier/wave5/biosphere/model.js` — feed labels/glyphs, taxonColor,
  hasCoords, observationsWithCoords, observationSubtitle (pure).
- `src/frontier/wave5/biosphere/index.js` — dock ticker + globe points
  (`init`): coord-bearing observations become Cesium points colored by
  iconic taxon with record links in the description, labels fade beyond
  8,000 km; 30-min refresh, chip toggle via trackLayer.
- `src/frontier/wave5/biosphere/biosphere.test.mjs` — 6 tests (pure model).
