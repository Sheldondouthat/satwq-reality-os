# INTEGRATION — 3.3 SOCRATES conjunction theater

## Files (this worker, Track 3a)
- `server/providers/wave3/socrates.js` — `/api/conjunctions` proxy (CelesTrak SOCRATES CSV, keyless)
- `server/providers/wave3/socrates.test.mjs` — 13 tests, passing
- `src/frontier/wave3/conjunctions/{model,source,index}.js`
- `src/frontier/wave3/conjunctions/conjunctions.test.mjs` — 8 tests, passing

No shared files were edited.

## (1) server/providers/local.js — exact lines

Add the import with the other wave3-adjacent imports (after the fireballs import line):

```js
import { socratesProxy } from './wave3/socrates.js';
```

Add the plugin at the end of the `localProviderPlugins()` array (after `fireballsProxy()`, preserving order):

```js
    fireballsProxy(),
    socratesProxy(),
```

## (2) server/pages/registry.mjs — exact lines

Append to the `REGISTRY` array, after the `fireballs` entry:

```js
  {
    name: 'conjunctions',
    routes: ['/api/conjunctions'],
    load: () => import('../providers/wave3/socrates.js').then((m) => m.socratesProxy()),
  },
```

Pages-safety: global fetch only, capped reads (1 MB CSV + capped TLE files),
no `node:` imports, no WASM, no `redirect: 'error'`. No exclusion needed.

## (3) initFrontier mount — exact lines

`attempt()` is synchronous, so the mount is a sync block with static imports
— matching the existing wave3 mounts. Add the imports at the top of
`src/frontier/index.js` with the other wave3 imports:

```js
import { createConjunctionLayer, createConjunctionPanel } from './wave3/conjunctions/index.js';
import { createConjunctionSource } from './wave3/conjunctions/source.js';
```

Inside `initFrontier`, after the fireballs `attempt(...)` block:

```js
  // — Wave 3a: SOCRATES conjunction theater —
  attempt('conjunctions', () => {
    const layer = createConjunctionLayer({ source: createConjunctionSource({}) });
    layer.init(viewer);
    const ctl = trackLayer('conjunctions', layer);
    const s = section(t('feature.conjunctions'));
    const panel = createConjunctionPanel({ layer });
    s.appendChild(panel.element);
    s.appendChild(chip('⚠ Conjunctions', (on) => { on ? (ctl.show(), panel.sync()) : ctl.hide(); }, true));
    dock.appendChild(s);
    ctl.show();
    return () => { panel.destroy(); layer.destroy(); };
  });
```

Fail-soft: `initConjunctions` (also exported as the generic `init`) never throws; without TLE enrichment the globe
shows nothing but the panel still lists every near-miss with countdowns.

## (4) UI strings for theme dictionaries

Add to `BASE_STRINGS` in `src/themes/engine.js`:

```js
'feature.conjunctions': 'Conjunction theater',
```

Optional per-theme flavor:
- NERV: `'feature.conjunctions': 'ORBITAL INTERCEPT FORECAST'`
- Noir: `'feature.conjunctions': 'Close encounters, overhead'`
- MedBay: `'feature.conjunctions': 'Near-miss events'`

## Data contract (for reference)

`GET /api/conjunctions?max=40` →
`{events:[{id,tcaUtc,noradId1,noradId2,name1,ops1,name2,ops2,minRangeKm,relSpeedKms,maxProb,dse1,dse2,tle1:{name,line1,line2}|null,tle2|null}],topByProbability,count,fetchedAt,upstream:{csv,csvAt,tleEnriched},honesty}`.
Upstream: `https://celestrak.org/SOCRATES/sort-minRange.csv` (keyless, ≤5 km,
7-day, SGP4/Max-Probability; `query.php` returned HTTP 404 on 2026-09-27 —
do NOT reintroduce it). The CSV parser accepts both human-readable headings
(`Days Since Epoch`, `Name`) and machine headings (`DSE_1`, `OBJECT_NAME_1`,
`MIN_RANGE`, `MAX_PROB`, …) — verified by unit tests against both families.
TLE enrichment is opportunistic from CelesTrak groups (60 s per fetch cap);
events without TLEs are never dropped.
