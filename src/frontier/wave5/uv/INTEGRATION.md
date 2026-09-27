# INTEGRATION — Wave 5 UV ticker (item 8)

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import after the `sigmetsProxy` import:

```js
import { uvProxy } from './wave5/uv.js';
```

Add the proxy in `localProviderPlugins()`, after `sigmetsProxy()`:

```js
    sigmetsProxy(),
    uvProxy(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM). Add after the `sigmets` entry, before the `radiation` entry:

```js
  {
    name: 'uv',
    routes: ['/api/uv'],
    load: () => import('../providers/wave5/uv.js').then((m) => m.uvProxy()),
  },
```

## 3. src/frontier/index.js

Add the import after the cableThreat import:

```js
import { init as initUv } from './wave5/uv/index.js';
```

Add the mount after the `// — Wave 3 Track 1a: cable-threat correlation —`
block, before the `// — Wave 3 Track 1a: NWS alert polygons —` block:

```js
  // — Wave 5 ticker: UV index (Open-Meteo) —
  attempt('uv', () => {
    const s = section(t('feature.uv'));
    dock.appendChild(s);
    return initUv({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js` (after `'feature.co2'`):

```js
  'feature.uv',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.uv': 'UV index',
```

## Files owned by this feature (do not move)

- `server/providers/wave5/uv.js` — provider factory (`uvProxy`), mounts
  `/api/uv` with validated `?latitude=&longitude=`, per-coordinate 30-min cache.
- `server/providers/wave5/uv.test.mjs` — 9 tests (fetch-mocked).
- `api/uv.js` — Vercel mount of `uvProxy`.
- `src/frontier/wave5/uv/model.js` — WHO UV bands, formatting.
- `src/frontier/wave5/uv/index.js` — dock ticker `init`.
- `src/frontier/wave5/uv/uv.test.mjs` — 5 model tests.
