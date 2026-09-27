# F2 — Planetary DVR · Integration Guide

**What it is:** a date-controllable wrapper around the verified NASA GIBS
WMTS true-color template (`MODIS_Terra_CorrectedReflectance_TrueColor`).
The GIBS TIME dimension is a `YYYY-MM-DD` path segment, so "scrubbing time"
= swapping the imagery provider's URL template. Includes a scrubber UI
(range slider + play/pause + LIVE reset) and graceful handling of dates with
no tiles (keeps the last good frame).

**Files (all new, nothing existing was touched):**

| File | Role |
|---|---|
| `src/layers/dvr/model.js` | Pure date math: validation, 30-day window, clamping, index mapping, `layer-time-actual` header parsing |
| `src/layers/dvr/source.js` | Date-controllable snapshot source + `probeDate()` tile-availability check |
| `src/layers/dvr/index.js` | `createDvrLayer()` (wraps the shared imagery-tile factory) + `createDvrControls()` scrubber DOM |
| `src/layers/dvr/dvr.test.mjs` | Unit tests (frozen clock) |

## Wiring (integrator: add to the layer registry / main bootstrap)

```js
import { createDvrLayer, createDvrControls } from './layers/dvr/index.js';

// 1. Create + register like any other layer (init/enable/disable/destroy,
//    update, getStats, getAnalystRecords all present).
const dvr = createDvrLayer();
dvr.init(viewer);
dvr.enable(viewer);           // starts on the latest (yesterday) frame
registerLayer(dvr);           // your existing catalog call

// 2. Scrubber UI — mount on the viewer container so it positions over the globe.
const controls = createDvrControls(dvr, { mount: viewerContainer });
// HUD toggle wiring:
hudToggle('dvr', (on) => { on ? dvr.enable(viewer) : (controls.destroy(), dvr.disable(viewer)); });
```

> **Replaces** the static `gibsTruecolor` layer in the catalog: DVR defaults to
> the same latest frame, so swapping the registration is visually seamless.
> Keep the old layer file untouched; just register `dvr` instead.

## Programmatic API

```js
await dvr.setTime('2026-09-20'); // probe → swap TIME dimension; throws DVR_DATE_UNAVAILABLE (keeps last good frame)
dvr.getTime();                   // '2026-09-20'
dvr.getRange();                  // { min:'2026-08-28', max:'2026-09-26', days:[...30] }
dvr.unavailableDates();          // dates probed with no tiles
dvr.play(); dvr.pause(); dvr.isPlaying();
await dvr.goLive();              // back to latest frame
dvr.getStats();                  // { date, live, playing, lastGoodDate, unavailable, ... }
```

## Behavior notes

- **Missing dates:** before committing, the layer fetches one z=2 tile and
  reads GIBS's `layer-time-actual` response header. If GIBS 404s or silently
  substitutes a different day, the date is recorded as unavailable, the
  previous frame stays on screen, and `setTime` rejects with
  `code: 'DVR_DATE_UNAVAILABLE'`. The scrubber shows "no frame YYYY-MM-DD".
- **Playback:** advances 1 day / 900 ms, pauses at the newest frame; dates
  with no tiles are skipped, not stalled on.
- **Scheduled `update()`:** a no-op unless in live mode (re-pins yesterday's
  frame at UTC rollover). Set `updateInterval` at construction if you want a
  different cadence (default 6 h).
- **Keys:** none. GIBS WMTS is keyless; both the tile host and the probe
  request send `Access-Control-Allow-Origin: *`.
