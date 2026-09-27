# INTEGRATION — Wave 5 carbon-intensity ticker (item 15)

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import after the `dartCouplingProxy` import:

```js
import { carbonProxy } from './wave5/carbon.js';
```

Add the proxy in `localProviderPlugins()`, after `dartCouplingProxy()`:

```js
    dartCouplingProxy(),
    carbonProxy(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM). Add after the `dart-coupling` entry, before the `water-twin` entry:

```js
  {
    name: 'carbon',
    routes: ['/api/carbon'],
    load: () => import('../providers/wave5/carbon.js').then((m) => m.carbonProxy()),
  },
```

## 3. src/frontier/index.js

Add the import after the `createSigmetsLayer` import:

```js
import { init as initCarbon } from './wave5/carbon/index.js';
```

Add the mount after the `// — Wave 3 Track 1a: aviation SIGMETs —` block,
before the `// — Wave 3 Track 1a: Terminator Rush —` block:

```js
  // — Wave 5 ticker: GB grid carbon intensity (National Grid ESO) —
  attempt('carbon', () => {
    const s = section(t('feature.carbon'));
    dock.appendChild(s);
    return initCarbon({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js` (after `'feature.markets'`):

```js
  'feature.carbon',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.carbon': 'Grid carbon intensity',
```

## Files owned by this feature (do not move)

- `server/providers/wave5/carbon.js` — provider factory (`carbonProxy`),
  mounts `/api/carbon`, 30-min cache on the National Grid ESO half-hourly window.
- `server/providers/wave5/carbon.test.mjs` — 7 tests (fetch-mocked).
- `api/carbon.js` — Vercel mount of `carbonProxy`.
- `src/frontier/wave5/carbon/model.js` — ESO index colors, formatting.
- `src/frontier/wave5/carbon/index.js` — dock ticker `init`.
- `src/frontier/wave5/carbon/carbon.test.mjs` — 5 model tests.
