# INTEGRATION — 3.2 Fireball impacts (CNEOS)

## Files (this worker, Track 3a)
- `server/providers/wave3/fireballs.js` — `/api/fireballs` proxy (CNEOS, keyless)
- `server/providers/wave3/fireballs.test.mjs` — 7 tests, passing
- `src/frontier/wave3/fireballs/{model,showers,source,index}.js`
- `src/frontier/wave3/fireballs/fireballs.test.mjs` — 9 tests, passing

No shared files were edited.

## (1) server/providers/local.js — exact lines

Add the import with the other wave3-adjacent imports (after the vaac import line):

```js
import { fireballsProxy } from './wave3/fireballs.js';
```

Add the plugin at the end of the `localProviderPlugins()` array (after `vaacProxy()`, preserving order):

```js
    vaacProxy(),
    fireballsProxy(),
```

## (2) server/pages/registry.mjs — exact lines

Append to the `REGISTRY` array, after the `vaac` entry:

```js
  {
    name: 'fireballs',
    routes: ['/api/fireballs'],
    load: () => import('../providers/wave3/fireballs.js').then((m) => m.fireballsProxy()),
  },
```

Pages-safety: global fetch only, capped reads (2 MB), no `node:` imports, no
WASM, no `redirect: 'error'` (workerd rejects it — default `follow` used).
No exclusion needed.

## (3) initFrontier mount — exact lines

`attempt()` is synchronous, so the mount is a sync block with static imports
— matching the existing wave3 mounts. Add the imports at the top of
`src/frontier/index.js` with the other wave3 imports:

```js
import { createFireballLayer, createFireballPanel } from './wave3/fireballs/index.js';
import { createFireballSource } from './wave3/fireballs/source.js';
```

Inside `initFrontier`, after the cosmicRay `attempt(...)` block:

```js
  // — Wave 3a: CNEOS fireball impacts —
  attempt('fireballs', () => {
    const layer = createFireballLayer({ source: createFireballSource({}) });
    layer.init(viewer);
    const ctl = trackLayer('fireballs', layer);
    const s = section(t('feature.fireballs'));
    const panel = createFireballPanel({ layer });
    s.appendChild(panel.element);
    s.appendChild(chip('☄ Fireballs', (on) => { on ? (ctl.show(), panel.sync()) : ctl.hide(); }, true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.destroy(); layer.destroy(); };
  });
```

Fail-soft: `initFireballs` (also exported as the generic `init`) never throws; if `/api/fireballs` is down the layer
mounts with zero entities and the panel shows its waiting state.

## (4) UI strings for theme dictionaries

Add to `BASE_STRINGS` in `src/themes/engine.js` (t() falls back to BASE_STRINGS,
so all 14 themes work with zero per-theme edits):

```js
'feature.fireballs': 'Fireball impacts',
```

Optional per-theme flavor (themes.js manifests, not required):
- NERV: `'feature.fireballs': 'IMPACT EVENTS (CNEOS)'`
- MedBay: `'feature.fireballs': 'Atmospheric entry events'`
- Noir: `'feature.fireballs': 'Rocks that made the news'`

## Data contract (for reference)

`GET /api/fireballs?days=30&minKt=0` →
`{events:[{id,dateUtc,energyKt,impactEnergyKt,radiatedE10J,lat,lon,altKm,velKms,recent}],count,archiveCount,fetchedAt,upstream,honesty}`.
Upstream: `https://ssd-api.jpl.nasa.gov/fireball.api?req-loc=true` (keyless,
verified live 2026-09-27; fields `date,energy,impact-e,lat,lat-dir,lon,lon-dir,alt,vel`).
**Unit mapping (CNEOS API doc v1.2, verified 2026-09-27):** `energy` is total
RADIATED energy in 10^10 J — NOT kilotons; `energyKt`/`impactEnergyKt` come
from `impact-e` (true kilotons); `energy` is kept as `radiatedE10J`,
honestly labeled. (Chelyabinsk: energy=37500, impact-e=441.) `?minKt=`
filters true kilotons.
Energies are kilotons TNT, roughly factor-of-two uncertainty — the payload and
the panel both say so. Shower cross uses a static major-shower peak table
(`showers.js`); associations are date-window only, labeled as such.
