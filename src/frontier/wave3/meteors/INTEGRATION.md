# Wave 3 Track 2c / 2.14 — Global Meteor Network night-side meteors — Integration Guide

Polls the Global Meteor Network daily trajectory summary and renders
meteor streaks **only for events whose trajectory midpoint was on Earth's
dark hemisphere at event time** (historical solar terminator computed
per-event — the physics-honesty requirement: meteors are only visible at
night). Also feeds W8's skywatch with the same night-filtered shape.

**Constraint honored:** this feature ships as new files only. Every edit to
an *existing* file below is listed as an exact snippet for the integrator —
nothing in this feature modifies existing files itself.

---

## 1. New files (this feature)

| File | Role |
|---|---|
| `server/providers/wave3/gmn.js` | `export function gmnProxy({fetchImpl, now})` — mounts `/api/meteors`; tries `traj_summary_latest_daily.txt`, falls back to `traj_summary_yesterday.txt`. Workerd-safe. Exports `parseGmnUtc`, `normalizeGmnRow`, `parseGmnSummary`. |
| `src/frontier/wave3/meteors/model.js` | `subsolarPoint` (NOAA solar equations), `solarZenithDeg`, `isNightSide`, `filterNightSide`, `streakDeg`. |
| `src/frontier/wave3/meteors/source.js` | `createMeteorsSource({fetchImpl, apiPath})` — browser snapshot client. |
| `src/frontier/wave3/meteors/index.js` | `init({viewer, apiPath})` — fail-soft Cesium mount; night-side streaks as polylines, 30-min refresh. |
| `src/frontier/wave3/meteors/meteors.test.mjs` | 8 tests: UTC timestamp parsing (not local), real trajectory fields, comment/CR skipping, subsolar sanity near equinox, day/night separation, night filter. |

## 2. Probe outcomes (verified 2026-09-27)

| Fact | Detail |
|---|---|
| Directory | `https://globalmeteornetwork.org/data/traj_summary_data/daily/` exposes `traj_summary_latest_daily.txt` + `traj_summary_yesterday.txt` |
| Layout | `;`-delimited; line 0 is a `#`-comment (with `\r`); UTC `YYYY-MM-DD HH:MM:SS.ffffff` at field 2; LatBeg/LonBeg/LatEnd/LonEnd at 0-based fields 63/65/69/71; `vInit` field 59; mass field 79 |
| Sample | 965 lines / 961 data rows; real row `20260925101453_a42p2` parsed end-to-end |
| Physics | Subsolar point at 2026-09-25 10:14 UTC ≈ (24°E, −1°) — matches the September equinox within tolerance; zenith at subsolar point < 1° |

## 3. Wiring snippets (edits to existing files — apply in order)

### 3a. Server proxy — dev/prod server

`server/providers/local.js` — add the import after the gdelt import:

```js
import { gdeltProxy } from './wave3/gdelt.js';
import { gmnProxy } from './wave3/gmn.js';   // ADD
```

and in `localProviderPlugins()`, after `gdeltProxy(),`:

```js
    gdeltProxy(),
    gmnProxy(),   // ADD
```

### 3b. Cloudflare Pages Functions registry

`server/pages/registry.mjs` — append to `REGISTRY` after the `gdelt` entry:

```js
  {   // ADD
    name: 'gmn',
    routes: ['/api/meteors'],
    load: () => import('../providers/wave3/gmn.js').then((m) => m.gmnProxy()),
  },
];
```

Workerd safety: global `fetch` only, no `node:` imports, no WASM, no npm
deps; imports only `./lib/proxy.js` → `../../common/http.js` (plain fetch/JSON).

### 3c. Mount call — `src/frontier/index.js` `initFrontier`

```js
import { init as initWave3Meteors } from './wave3/meteors/index.js';   // ADD (top imports)
// inside initFrontier (viewer is in scope):
  // — Wave 3 Track 2c / 2.14: GMN night-side meteor streaks —
  attempt('wave3-meteors', () => {
    const handle = initWave3Meteors({ viewer });
    return () => handle?.destroy?.();
  });
```

### 3d. Theme dictionary strings — `src/themes/engine.js`

In the master key list (after `'feature.gdelt',`):

```js
  'feature.meteors',
```

and in `BASE_STRINGS` (after `'feature.gdelt.negative': 'Negative tone',`):

```js
  'feature.meteors': 'Night-side meteors (GMN)',
  'feature.meteors.velocity': 'Entry velocity',
  'feature.meteors.mass': 'Estimated mass',
```

## 4. Consumer contract

`GET /api/meteors` → 200

```json
{
  "fetchedAt": 1758940000000, "stale": false, "unavailable": false, "reason": null,
  "dayFile": "traj_summary_latest_daily.txt", "count": 961, "nightCount": 512,
  "meteors": [{
    "id": "20260925101453_a42p2", "timeMs": 1758797693093,
    "latBeg": 34.3051, "lonBeg": -113.0409, "latEnd": 34.2411, "lonEnd": -112.9531,
    "vInitKmS": 66.7027, "massKg": 0.0042, "nightSide": true
  }]
}
```

- `nightSide` is computed server-side per event with the historical solar
  terminator (same math the globe uses client-side).
- Both day files missing/upstream down + no cache → 502; down + cache → `stale:true`.

## 5. Behavior contract

- Cache TTL 30 min; body cap 4 MB; timeout 30 s per candidate file; max
  1500 meteors served (newest first).
- Timestamps are parsed as UTC explicitly — never local time.
- Day-side events are filtered, never rendered (meteor visibility is a
  night phenomenon; rendering day-side events would be dishonest).
- Keyless. No keys, no paid deps, no WASM, no `node:` imports in the registry path.
