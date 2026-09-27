# INTEGRATION — 3.4 TLE decay prediction

## Files (this worker, Track 3a)
- `server/providers/wave3/reentries.js` — `/api/reentries` (CelesTrak groups + TLE drag-extrapolation model, keyless)
- `server/providers/wave3/reentries.test.mjs` — 4 tests, passing
- `src/frontier/wave3/reentry/{tleMath,tleMath.test.mjs,model,source,index}.js`
- `src/frontier/wave3/reentry/reentry.test.mjs` — 11 tests, passing

No shared files were edited.

## (1) server/providers/local.js — exact lines

Add the import with the other wave3-adjacent imports (after the socrates import line):

```js
import { reentriesProxy } from './wave3/reentries.js';
```

Add the plugin at the end of the `localProviderPlugins()` array (after `socratesProxy()`, preserving order):

```js
    socratesProxy(),
    reentriesProxy(),
```

## (2) server/pages/registry.mjs — exact lines

Append to the `REGISTRY` array, after the `conjunctions` entry:

```js
  {
    name: 'reentries',
    routes: ['/api/reentries'],
    load: () => import('../providers/wave3/reentries.js').then((m) => m.reentriesProxy()),
  },
```

Pages-safety: global fetch only, capped reads (1.5 MB per group), no `node:`
imports, no WASM, no `redirect: 'error'`. No exclusion needed.

## (3) initFrontier mount — exact lines

`attempt()` is synchronous, so the mount is a sync block with static imports
— matching the existing wave3 mounts. Add the imports at the top of
`src/frontier/index.js` with the other wave3 imports:

```js
import { createReentryLayer, createReentryPanel } from './wave3/reentry/index.js';
import { createReentrySource } from './wave3/reentry/source.js';
```

Inside `initFrontier`, after the conjunctions `attempt(...)` block:

```js
  // — Wave 3a: TLE decay prediction —
  attempt('reentry', () => {
    const layer = createReentryLayer({ source: createReentrySource({}) });
    layer.init(viewer);
    const ctl = trackLayer('reentry', layer);
    const s = section(t('feature.reentry'));
    const panel = createReentryPanel({ layer });
    s.appendChild(panel.element);
    s.appendChild(chip('🛰 Reentries', (on) => { on ? (ctl.show(), panel.sync()) : ctl.hide(); }, true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.destroy(); layer.destroy(); };
  });
```

Fail-soft: `initReentries` (also exported as the generic `init`) never throws; candidates without TLEs are skipped
for tracks but still listed in the panel with their modeled timing.

## (4) UI strings for theme dictionaries

Add to `BASE_STRINGS` in `src/themes/engine.js`:

```js
'feature.reentry': 'Reentry watch',
```

Optional per-theme flavor:
- NERV: `'feature.reentry': 'DECAY PREDICTION (MODELED)'`
- MedBay: `'feature.reentry': 'Orbital decay watch'`
- Noir: `'feature.reentry': 'Things falling out of the sky'`

## Data contract (for reference)

`GET /api/reentries?max=25` →
`{candidates:[{id,name,noradId,meanMotion,ecc,ndt2,perigeeKm,apogeeKm,daysLow,daysHigh,daysMid,tcaUtc,tcaMs,tcaDays,windowHours,urg,bandHalfDays,tle:{name,line1,line2}}],count,fetchedAt,upstream:{groups,fetchedGroups,failedGroups},honesty}`.
Upstream: CelesTrak `analyst` + `cosmos-2251-debris` + `fengyun-1c-debris` +
`iridium-33-debris` TLE groups (keyless, all verified live 2026-09-27; the
`other` and `last-30-days` group names are NOT valid TLE groups). The timing model is a LINEAR DRAG
EXTRAPOLATION of the TLE first-derivative field — crude by construction; the
payload, the panel, and every label say so. Uncertainty bands are ±25%
heuristic windows rendered as dim early/late ground tracks. Land-overflight
alerts use a coarse built-in continent-rectangle test (±5°, documented in
`model.js` `LAND_BOXES`) and are labeled heuristic everywhere they appear.
