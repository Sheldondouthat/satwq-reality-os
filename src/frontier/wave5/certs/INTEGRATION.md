# INTEGRATION — Wave 5 cert-transparency ticker (item 24)

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import after the `waterTwinProxy` import:

```js
import { certsProxy } from './wave5/certs.js';
```

Add the proxy in `localProviderPlugins()`, after `waterTwinProxy()`:

```js
    waterTwinProxy(),
    certsProxy(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM). Add after the `water-twin` entry, before the closing `];`:

```js
  {
    name: 'certs',
    routes: ['/api/certs'],
    load: () => import('../providers/wave5/certs.js').then((m) => m.certsProxy()),
  },
```

## 3. src/frontier/index.js

Add the import after the terminatorRush import:

```js
import { init as initCerts } from './wave5/certs/index.js';
```

Add the mount after the `// — Wave 3 Track 1a: Terminator Rush —` block,
before the `// — sci-fi B1 deep time —` block:

```js
  // — Wave 5 ticker: certificate transparency (crt.sh) —
  attempt('certs', () => {
    const s = section(t('feature.certs'));
    dock.appendChild(s);
    return initCerts({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js` (after `'feature.carbon'`):

```js
  'feature.certs',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.certs': 'Certificate transparency',
```

## Files owned by this feature (do not move)

- `server/providers/wave5/certs.js` — provider factory (`certsProxy`),
  mounts `/api/certs?q=` (validated), 4 MB body cap + 50-row hard cap with
  `capped: true` flag, per-domain 1h cache.
- `server/providers/wave5/certs.test.mjs` — 10 tests (fetch-mocked, incl.
  the 400-on-bad-query and row-cap cases).
- `api/certs.js` — Vercel mount of `certsProxy`.
- `src/frontier/wave5/certs/model.js` — expiry labels/colors.
- `src/frontier/wave5/certs/index.js` — dock ticker `init`.
- `src/frontier/wave5/certs/certs.test.mjs` — 4 model tests.
