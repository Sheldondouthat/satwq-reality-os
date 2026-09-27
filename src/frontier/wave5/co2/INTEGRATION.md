# INTEGRATION — Wave 5 CO₂ ticker (item 6)

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import after the `nwsAlertsProxy` import:

```js
import { co2Proxy } from './wave5/co2.js';
```

Add the proxy in `localProviderPlugins()`, after `nwsAlertsProxy()`:

```js
    nwsAlertsProxy(),
    co2Proxy(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM). Add after the `nws-alerts` entry, before the `sigmets` entry:

```js
  {
    name: 'co2',
    routes: ['/api/co2'],
    load: () => import('../providers/wave5/co2.js').then((m) => m.co2Proxy()),
  },
```

## 3. src/frontier/index.js

Add the import after the `initDonki` import:

```js
import { init as initCo2 } from './wave5/co2/index.js';
```

Add the mount after the `// — Wave 3 Track 2a: solar storms (NASA DONKI) —`
block, before the `// — Wave 3 Track 1a: cable-threat correlation —` block:

```js
  // — Wave 5 ticker: atmospheric CO₂ (NOAA GML, Mauna Loa) —
  attempt('co2', () => {
    const s = section(t('feature.co2'));
    dock.appendChild(s);
    return initCo2({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js` (after `'feature.nwsAlerts'`):

```js
  'feature.co2',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.co2': 'CO₂ (Mauna Loa)',
```

## Files owned by this feature (do not move)

- `server/providers/wave5/_lib.js` — shared wave5 plumbing (capped fetch,
  TTL+inflight cache, sendJson, buildProxy).
- `server/providers/wave5/co2.js` — provider factory (`co2Proxy`), mounts
  `/api/co2`, 6h cache, parses NOAA GML daily CSV tail.
- `server/providers/wave5/co2.test.mjs` — 8 tests (fetch-mocked).
- `api/co2.js` — Vercel mount of `co2Proxy`.
- `src/frontier/wave5/co2/model.js` — ppm formatting, trend glyph, delta line.
- `src/frontier/wave5/co2/index.js` — dock ticker `init`.
- `src/frontier/wave5/co2/co2.test.mjs` — 5 model tests.
