# INTEGRATION — Wave 5 markets ticker (item 14)

Do NOT edit shared files yourself from this worker's scope. The parent
applies the lines below verbatim.

## 1. server/providers/local.js

Add the import after the `radiationProxy` import:

```js
import { marketsProxy } from './wave5/markets.js';
```

Add the proxy in `localProviderPlugins()`, after `radiationProxy()`:

```js
    radiationProxy(),
    marketsProxy(),
```

## 2. server/pages/registry.mjs

No exclusion applies (keyless, global-fetch-only, no node: imports, no
WASM). Add after the `radiation` entry, before the `dart-coupling` entry:

```js
  {
    name: 'markets',
    routes: ['/api/markets'],
    load: () => import('../providers/wave5/markets.js').then((m) => m.marketsProxy()),
  },
```

## 3. src/frontier/index.js

Add the import after the `createNwsAlertsLayer` import:

```js
import { init as initMarkets } from './wave5/markets/index.js';
```

Add the mount after the `// — Wave 3 Track 1a: NWS alert polygons —` block,
before the `// — Wave 3 Track 1a: aviation SIGMETs —` block:

```js
  // — Wave 5 ticker: markets (Frankfurter FX + BTC spot) —
  attempt('markets', () => {
    const s = section(t('feature.markets'));
    dock.appendChild(s);
    return initMarkets({ viewer, mount: s, chip, trackLayer, t });
  });
```

## 4. Theme terminology dictionaries (src/themes/engine.js + src/themes/themes.js)

Add to the known-key list in `engine.js` (after `'feature.uv'`):

```js
  'feature.markets',
```

Add to `BASE_STRINGS` in `engine.js` and to every theme dictionary in
`themes.js`:

```js
  'feature.markets': 'Markets (FX · BTC)',
```

## Files owned by this feature (do not move)

- `server/providers/wave5/markets.js` — provider factory (`marketsProxy`),
  mounts `/api/markets`, 5-min cache, Frankfurter FX + CoinGecko/Binance
  US/Coinbase BTC legs with per-source degraded flags (CoinGecko failure
  incl. 429 degrades that leg only, never retries).
- `server/providers/wave5/markets.test.mjs` — 8 tests (fetch-mocked,
  incl. the CoinGecko-429 degraded-leg case).
- `api/markets.js` — Vercel mount of `marketsProxy`.
- `src/frontier/wave5/markets/model.js` — USD/FX formatting, leg status.
- `src/frontier/wave5/markets/index.js` — dock ticker `init`.
- `src/frontier/wave5/markets/markets.test.mjs` — 5 model tests.
