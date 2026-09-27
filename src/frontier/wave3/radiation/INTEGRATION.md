# INTEGRATION — radiation (wave3 sci-fi B #4)

**Status:** provider + client complete, 8/8 provider tests passing. No
shared-file edits made by the author; the parent applies the lines below.

## 1. server/providers/local.js — ADD

Import line (with the other provider imports, after the vaac import):

```js
import { radiationProxy } from './wave3/radiation.js';
```

Plugin list (inside `localProviderPlugins()`, after `vaacProxy(),`):

```js
    radiationProxy(),
```

## 2. server/pages/registry.mjs — ADD

Entry in `REGISTRY` (after the `vaac` entry; provider is Pages-safe —
global fetch only, no `node:` imports, capped reads):

```js
  {
    name: 'radiation',
    routes: ['/api/radiation'],
    load: () => import('../providers/wave3/radiation.js').then((m) => m.radiationProxy()),
  },
```

## 3. initFrontier mount call (src/frontier/index.js)

Static import (top of file):

```js
import { init as initRadiation } from './wave3/radiation/index.js';
```

Attempt block — place after the what-if block:

```js
  // — sci-fi B4 radiation map —
  attempt('radiation', () => {
    const s = section(t('feature.radiation'));
    dock.appendChild(s);
    const rad = initRadiation(viewer, { mount: s });
    if (!rad) return () => {};
    return () => rad.destroy();
  });
```

## 4. Theme dictionary strings (src/themes/engine.js)

```js
  'feature.radiation': 'Radiation map (Safecast)',
```

## Data-source verification (for the record)

- **Safecast** `https://api.safecast.org/en-US/measurements?unit=usv&order=desc&limit=N`
  with `Accept: application/json` — VERIFIED LIVE 2026-09-27 (HTTP 200,
  readings minutes old, keyless, no auth). Used.
- **uRadMonitor** `data.uradmonitor.com/api/v1/devices` — now requires
  `X-User-id` / `X-User-hash` auth; returns `{"error":"Authentification
  failed"}` keyless. EXCLUDED (keyed). Verified 2026-09-27.
- **OpenRadiation** `request.openradiation.net/measurements` — requires
  `apiKey` parameter (`{"error":{"code":"100","message":"You must send the
  apiKey parameter"}}`). EXCLUDED (keyed). Verified 2026-09-27.

## Notes

- `/api/radiation` serves `{ schemaVersion: 1, source, attribution,
  fetchedAt, stale, unavailable, reason, points: [{lat, lon, valueUsvH,
  unit, capturedAt}] }`, ≤600 points, 10-min cache / 60-min stale window /
  60-s retry cooldown — same shape discipline as the other wave3 proxies.
- `doseBand` lives in `src/frontier/wave3/radiation/model.js` and is
  re-exported by the provider (server→src direction, matching the
  invisibleOceanProxy precedent).
