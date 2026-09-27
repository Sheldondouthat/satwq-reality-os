# INTEGRATION — 3.1 Cosmic-ray weather (NMDB)

## Files
- `server/providers/wave3/nmdb.js` — `/api/nmdb` proxy (W5, Track 2b; already in tree, NOT yet registered)
- `src/frontier/wave3/nmdb/{source,index}.js` — W5 data layer (`createNmdbSource`, `/api/nmdb` client)
- `src/frontier/wave3/cosmicRay/{model,index}.js` — this worker (Track 3a): station nodes + Forbush watch
- `src/frontier/wave3/cosmicRay/cosmicRay.test.mjs` — 7 tests, passing

No shared files were edited. This feature consumes W5's provider and data
layer; it does not duplicate them.

## (1) server/providers/local.js — exact lines

W5's provider is not registered yet; both lines are required for this
feature (and for W5's own). Add the import with the other wave3 imports:

```js
import { nmdbProxy } from './wave3/nmdb.js';
```

Add the plugin in the `localProviderPlugins()` array (before `fireballsProxy()`, preserving order):

```js
    nmdbProxy(),
    fireballsProxy(),
```

## (2) server/pages/registry.mjs — exact lines

Append to the `REGISTRY` array (before the `fireballs` entry, matching the local.js order):

```js
  {
    name: 'nmdb',
    routes: ['/api/nmdb'],
    load: () => import('../providers/wave3/nmdb.js').then((m) => m.nmdbProxy()),
  },
```

Pages-safety: global fetch only, capped reads (2 MB), no `node:` imports, no
WASM, no `redirect: 'error'`. No exclusion needed.

## (3) initFrontier mount — exact lines

`attempt()` is synchronous (it calls `fn()` and keeps a returned cleanup),
so the mount is a sync block with static imports — matching the existing
wave3 mounts (`initAkashicArchive`, `initWebXR`, …). Add the imports at the
top of `src/frontier/index.js` with the other wave3 imports:

```js
import { createCosmicRayLayer, createCosmicRayPanel } from './wave3/cosmicRay/index.js';
import { createNmdbSource } from './wave3/nmdb/index.js';
```

Inside `initFrontier`, before the fireballs `attempt(...)` block:

```js
  // — Wave 3a: cosmic-ray weather (NMDB) —
  attempt('cosmicRay', () => {
    const layer = createCosmicRayLayer({ nmdbSource: createNmdbSource({}) });
    layer.init(viewer);
    const ctl = trackLayer('cosmicRay', layer);
    const s = section(t('feature.cosmicRay'));
    const panel = createCosmicRayPanel({ layer });
    s.appendChild(panel.element);
    s.appendChild(chip('◉ Cosmic rays', (on) => { on ? (ctl.show(), panel.sync()) : ctl.hide(); }, true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.destroy(); layer.destroy(); };
  });
```

Fail-soft: `initCosmicRay` (also exported as the generic `init`) never throws; if `/api/nmdb` is down the layer
mounts with zero nodes and the panel shows its waiting state. Station rows
arrive via W5's `createNmdbSource` (10-min refresh, last-good snapshot kept).

## (4) UI strings for theme dictionaries

Add to `BASE_STRINGS` in `src/themes/engine.js`:

```js
'feature.cosmicRay': 'Cosmic-ray weather',
```

Optional per-theme flavor:
- NERV: `'feature.cosmicRay': 'COSMIC FLUX MONITOR'`
- MedBay: `'feature.cosmicRay': 'Neutron monitor network'`
- Noir: `'feature.cosmicRay': 'Weather from deep space'`

## Data contract (for reference)

`GET /api/nmdb?days=1&stations=OULU,KERG` →
`{fetchedAt,period,ttlMs,stale,stations:[{code,name,lat,lon,latest:{t,value}|null,median,deviation,deviationMAD,samples,status}],unavailable,reason}`.
Upstream: NMDB NEST ASCII (`www.nmdb.eu/nest/draw_graph.php`, keyless,
verified live 2026-09-27). `deviation` is DERIVED: latest − 1-day median in
native series units; `deviationMAD` is DERIVED: deviation in median-absolute-
deviation units (robust z-score; null when the series is flat). Percent-of-
median is deliberately NOT used: with a near-zero window median it blew up to
−2934% on live Oulu data (W5, OBSERVED 2026-09-27). Forbush watch: coarse
(≤ −3 MAD simultaneous drop at ≥3 stations, 1-day window); labeled as a
watch, never an identification. No global-field claims: each node is its own
site.
