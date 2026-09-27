# Eyes-on countdown — Integration Guide

New files (this directory, created 2026-09-27). **No new server provider** —
this feature is pure compute over the EXISTING `/api/celestrak/resource` TLE
proxy plus the repo's SGP4 stack (`satellite.js`, `src/data/satellitePass.js`).

| File | Contents |
|---|---|
| `src/frontier/wave3/eyesOn/index.js` | `init({viewer, dock})` — lat/lon inputs + click-to-pick + "Find next eyes-on" → live countdown + ground-track polyline. Pure helpers: `parseTleText`, `isImagingCandidate`, `IMAGING_PATTERNS`, `formatCountdown`, `formatUtc`, `findEarliestPass`. |
| `src/frontier/wave3/eyesOn/eyesOn.test.mjs` | 7 tests, node:test — real SGP4 assertions against a static TLE (deterministic). |

No existing file was modified. No new npm deps (reuses `satellite.js`), no keys.

## 1. server/providers/local.js

Nothing to add — no new provider. (Uses the existing `celestrakProxy()`.)

## 2. server/pages/registry.mjs

Nothing to add — no new routes. The existing `celestrak` registry entry
(`/api/celestrak`) already covers the TLE feed this module consumes.

## 3. src/frontier/index.js — mount call

Add the import at the top:

```js
import { init as initEyesOn } from './wave3/eyesOn/index.js';
```

Add inside `initFrontier`, after the planetary-defense `attempt(…)` block:

```js
  // — Wave 3: eyes-on overpass countdown (pure SGP4 compute) —
  attempt('eyes-on', () => {
    const cleanup = initEyesOn({ viewer, dock });
    return typeof cleanup === 'function' ? cleanup : () => {};
  });
```

## 4. Theme dictionary strings

The module calls `t('feature.eyesOn')` for its dock section title.
Register in `src/themes/engine.js`: add `'feature.eyesOn',` to the key list
and to `BASE_STRINGS`:

```js
'feature.eyesOn': 'Eyes-on countdown',
```

Add one `strings` entry per manifest in `src/themes/themes.js`, e.g.:

| Theme flavor | Suggested string |
|---|---|
| neutral/default | `Eyes-on countdown` |
| medbay | `Overpass watch` |
| tactical/ops | `Imaging overpass countdown` |

Also add the key to `src/themes/KEYS.md` if it enumerates feature keys.

## Behavior contract

- Input: observer lat/lon (typed, globe-picked, or map-center).
- TLE source: `GET /api/celestrak/resource` (CelesTrak `resource` group,
  6 h server cache, fail-soft stale serving).
- Candidate filter: heuristic name match (`IMAGING_PATTERNS` — Landsat,
  Sentinel-2, SPOT, WorldView, …). Labeled in the UI as a heuristic.
- Pass criterion: elevation ≥ 25° ("eyes on" = usable imaging geometry),
  48 h horizon, coarse 90 s / fine 5 s search via `findNextSatellitePass`.
- Output: `👁 EYES ON in HH:MM:SS` countdown, then `OVERHEAD NOW`, then
  automatic re-search; SGP4 ground-track polyline (rise−15 min → set+15 min)
  drawn on the globe when a viewer is present.

## Physics-honesty notes (for reviewers)

- "Imaging-capable" is a NAME HEURISTIC, not a capability claim — optical vs
  SAR, resolution, and tasking status are not distinguished. Stated in the panel.
- The countdown is DERIVED from SGP4 propagation of public TLEs, not from an
  operator schedule. TLE age degrades accuracy; the existing proxy's 6 h
  refresh bounds staleness.
