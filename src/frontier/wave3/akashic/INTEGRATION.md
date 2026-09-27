# Akashic Records — integration notes (wave3, part C item 1)

Event archive + scrubbable history timeline. Fails soft; keyless only.

## 1. `server/providers/local.js` — NO LINES NEEDED

This feature adds **no new `/api/*` routes**. All sources are either fetched
directly from the browser (USGS GeoJSON, NWS alerts, NASA CNEOS — all keyless,
CORS-open) or reuse existing routes (`/api/events`, `/api/launches`,
`/api/cyclones`). Per PAGES_PORT.md, nothing is registered because there is
nothing to register.

## 2. `server/pages/registry.mjs` — EXCLUSION NOTE

No server providers were added (`server/providers/wave3/` intentionally does
not exist for this feature). The Pages Functions bundle is untouched: no new
imports, no WASM, no node:fs — nothing for esbuild to trace. Client-side only.

## 3. Mount call for `initFrontier` (in `src/frontier/index.js`)

Add inside `initFrontier`, next to the other wave3 attempts:

```js
import { initAkashicArchive } from './wave3/akashic/index.js';

// inside initFrontier, after the dock exists:
// — Wave3/C1 Akashic Records: event archive + timeline —
attempt('akashic', () => {
  const cleanup = initAkashicArchive({ viewer, dvr: newLayers.dvr || null });
  return () => { if (typeof cleanup === 'function') cleanup(); };
});
```

Note: `newLayers.dvr` is populated by the F2 mount earlier in `initFrontier`;
passing it wires the "view in GIBS DVR" button to `dvr.setTime(day)`.
Passing `null` simply disables that button (timeline still works).

## 4. UI strings for theme dictionaries

Add to each theme's dictionary (canonical keys):

| Key | Default text |
|---|---|
| `feature.akashic` | `Planetary memory` |
| `ui.akashic.open` | `◈ records` |
| `ui.akashic.replayDay` | `▶ replay the day` |
| `ui.akashic.viewInDvr` | `view in GIBS DVR` |
| `ui.akashic.noDays` | `no archived days yet` |

Current code uses inline English strings; mapping them to `t('feature.akashic')`
etc. is a follow-up for whoever wires theme dictionaries.

## 5. Seam with worker W3 (watch-queries + cinematic replay, item 1.11)

**I own:** `src/frontier/wave3/akashic/*` — the EVENT ARCHIVE (day-keyed
localStorage schema, archiver sweeps, significance thresholds) and the
TIMELINE UX (day scrubber, event list, camera replay).

**W3 owns:** watch-queries (user-defined "alert me when X happens") and the
cinematic replay experience (director-driven fly-throughs of a day).

The seam: W3's cinematic replay should read from this archive via
`store.eventsForDay(day)` (exported from `store.js`) rather than building a
second archive. My timeline's "replay the day" is a simple chronological
camera hop — deliberately the poor cousin of W3's director-driven replay.
File names are distinct (`wave3/akashic/*` vs whatever W3 names its own) so
there is no collision.

## File map

- `schema.js` — record shape, day keys, significance thresholds, validation
- `store.js` — day-keyed store (localStorage backend + memory fallback)
- `archiver.js` — record builders per source + `runArchiveSweep()`
- `timeline.js` — scrubbable timeline panel ("replay the day")
- `index.js` — `initAkashicArchive({ viewer, dvr, pollMs })` fail-soft mount
- `akashic.test.mjs` — 20 tests, all passing
