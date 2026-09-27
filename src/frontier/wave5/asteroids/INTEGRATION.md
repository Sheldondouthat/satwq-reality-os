# INTEGRATION.md — Wave 5 JPL close-approach asteroid ticker (`wave5/asteroids`)

Feature dir: `src/frontier/wave5/asteroids/`
Server provider: `server/providers/wave5/asteroids.js` (+ `asteroids.test.mjs`, 8 tests — all passing)
Vercel route: `api/asteroids.js`
Client tests: `src/frontier/wave5/asteroids/model.test.mjs` (10) — all passing, runs in `node scripts/run-unit-tests.mjs` scope.

## What it does

`GET /api/asteroids` serves NASA/JPL CNEOS close-approach data (catalog #65) in the
trimmed shape `{generatedAt, count, window, source, approaches:[{des,cd,distAu,distLd,vRelKms,h}]}`.
`date-min` / `date-max` / `dist-max` pass through to the upstream with validation
(400 `asteroids_bad_request` on bad input); per-window cache ~1h.

The frontier layer is a dock ticker: a chronological list of upcoming approaches
with lunar-distance framing (inside Moon's orbit / very close / near-Earth /
distant flyby) and countdowns. No globe entities — the task scope was the list.

## Relation to the existing /api/neo — READ THIS BEFORE WIRING

`server/providers/wave3/neo.js` ALREADY serves the same upstream (NASA/JPL
CNEOS `cad.api`, same fields `des, cd, dist, v_rel, H`, same lunar-distance
math) with a richer board shape (diameter estimates, physics notes, per-key
cache). Per the queue note on this item ("extend it instead"), neo.js was
**extended rather than duplicated**:

- `parseCadParams(searchParams)` — exported; parses + validates
  date-min/date-max/dist-max (400 on invalid), defaults = the historical
  7-day / 0.05 AU window (backward compatible).
- `fetchApproaches({dateMin, dateMax, distMaxAu})` — exported; the raw
  upstream fetch + `transformCadRow()` pipeline, no cache.
- `neoProxy()` now reads its query string (connect-stripped `req.url`) and
  caches per param key (6h), so `/api/neo?dist-max=0.1` works too.
- `window` is capped: `dist-max ≤ 1 AU`, span ≤ 365 days.

`wave5/asteroids.js` reuses exactly those two exports — there is one upstream
pipeline, two routes: `/api/neo` (wave-3 board, enriched) and
`/api/asteroids` (catalog-#65 trimmed shape). The frontier legend says so.

## 1. Exact lines for `server/pages/registry.mjs`

Add the entry before the closing `];` (after the water-twin entry):

```js
  {
    name: 'asteroids',
    routes: ['/api/asteroids'],
    load: () => import('../providers/wave5/asteroids.js').then((m) => m.asteroidsProxy()),
  },
```

## 2. Exact lines for `server/providers/local.js`

Add the import (after the reentries import line):

```js
import { asteroidsProxy } from './wave5/asteroids.js';
```

Add the plugin line (after `reentriesProxy(),`, before `keySetupEndpoint(),`):

```js
    reentriesProxy(),
    asteroidsProxy(),
    keySetupEndpoint(),
```

## 3. Exact mount call for `initFrontier` (inside the `initFrontier` body)

Add the import at the top of `src/frontier/index.js` (after the last `from './wave…'` import line):

```js
import { init as initWave5Asteroids } from './wave5/asteroids/index.js';
```

Add the mount block after the Wave 3a reentry block, before the `return {`:

```js
  // — Wave 5: JPL close-approach asteroid ticker —
  attempt('wave5-asteroids', () => {
    const s = section(t('feature.asteroids'));
    const handle = initWave5Asteroids({
      viewer,
      mount: (node) => s.appendChild(node),
      chip,
      trackLayer,
      t,
    });
    dock.appendChild(s);
    return () => handle?.();
  });
```

## 4. New UI strings for theme dictionaries

Add after the `'feature.reentry'` line in EACH of the 14 theme dictionaries in
`src/themes/themes.js` (lines ~146, 265, 384, 504, 623, 743, 862, 981, 1100,
1219, 1339, 1458, 1577, 1696):

```js
      'feature.asteroids': "Asteroid flybys",
```

(The chip and section fall back to `'Asteroid flybys'` if a theme is missing
the key, so a partially-applied theme edit degrades gracefully — but all 14
should be updated for consistency.)

## Honesty notes for the UI copy

- `cd` (close-approach date) is UTC per the CAD API — countdowns assume this.
- Miss distances are geocentric; 1 LD = 384,400 km; the dot colors mark
  inside-Moon's-orbit (<1 LD), very close (<5 LD), near-Earth (<20 LD),
  distant flyby (≥20 LD).
- H is absolute magnitude — a brightness measure, NOT a diameter; the panel
  labels it as such (the wave-3 /api/neo board carries the albedo-estimated
  diameter ranges with their uncertainty note).
- Rows with unparseable dates sort last and show "date n/a"; rows with blank H
  show "H unlisted" rather than a fabricated value.

## Verification

- `node --test server/providers/wave5/asteroids.test.mjs` — 8/8 pass.
- `node --test src/frontier/wave5/asteroids/model.test.mjs` — 10/10 pass.
- `server/providers/wave3/neo.js` still passes `node --check`; `parseCadParams`
  defaults and validation smoke-tested via `node -e` (no test file existed for
  neo before this change).
- Not yet applied: the four INTEGRATION.md edits above (shared files — left to
  the integrator).
