# INTEGRATION.md — 1.11 Watch queries + Akashic replay (`wave3/watchReplay`)

Feature dir: `src/frontier/wave3/watchReplay/`
Tests: `src/frontier/wave3/watchReplay/watchReplay.test.mjs` (24) — all passing.
No server provider (client-side by design: USGS serves CORS; the water twin
is already proxied at `/api/water-twin`). No shared-file edits.

## Modules

- `watches.js` — `parseWatchQuery` / `resolveWatchCenter` / `evaluateWatch`.
  Supported: "alert me when M7+ within 500 km of Tokyo" (quake) and
  "notify me when the Mississippi at St. Louis floods" (river, matched
  against the waterTwin registry names). Free text → `kind:'custom'` with
  `needsReview:true` — it never fires silently.
- `scheduler.js` — cron-compatible schedules (`*`, `*/n`, integers in
  minute/hour; dom/month/dow must be `*` — anything else is a hard parse
  error, never a silent mis-schedule) + in-process `setInterval` fallback.
  Storage is injected (localStorage in the browser).
- `eventLog.js` — persistent day-keyed log. Key:
  `satwq.eventlog.YYYY-MM-DD` → `{v:1, day, events:[...], updatedAt}`.
  Cap 5000 events/day, dedupe by t+type+label, `pruneDays(keepDays)`.
- `replay.js` — `createReplay({viewer, sonify, dvr})`; `playDay({day,
  events, speed, onStep})` composes GIBS time-scrub (`dvr.goTo`), camera
  flyTo, and the sonification bus per event, in chronological order.
  Cancel-safe: `stop()` always settles `done` (bug class caught by tests).
- `index.js` — `initWatchReplay({viewer, mount, fetchImpl, geocode,
  sonify, dvr})`: dock panel (watch input + list + "Run watches now" +
  "Replay yesterday"), hourly quake-feed sampling into today's log.

## 1. Exact lines for `server/providers/local.js`

None — no provider. (Client fetches USGS directly with CORS + the
`/api/water-twin` proxy.)

## 2. Exact lines for `server/pages/registry.mjs`

None — no new routes. Exclusion note: not applicable (no provider exists).

## 3. Exact mount call for `initFrontier` (inside the `initFrontier` body)

Add the import at the top of `src/frontier/index.js`:

```js
import { initWatchReplay } from './wave3/watchReplay/index.js';
```

Add a mount attempt (after the water-twin block). `sonification` is the
existing F8 handle; `dvr` is optional (replay skips the time-scrub when
absent):

```js
  // — Wave 3 · 1.11 watch queries + Akashic replay —
  attempt('watch-replay', () => {
    const s = section(t('feature.watchReplay'));
    const handle = initWatchReplay({
      viewer,
      mount: (node) => s.appendChild(node),
      sonify: sonification,
    });
    dock.appendChild(s);
    return () => handle.destroy();
  });
```

Cron-driven evaluation (optional follow-up, not required for the mount): a
runtime cron can instantiate `createScheduler` with the same storage key
(`satwq.watches.v1`) and call `tick()` — the schedule is data, so the
in-process and cron paths evaluate identical watches.

## 4. New UI strings for theme dictionaries

```js
'feature.watchReplay': 'Watch queries + day replay',
```

## Honesty notes

- A watch is a *query evaluated on a schedule*, not a prediction.
- Custom (unparsed) watches are stored but flagged `needsReview` and never
  auto-fire.
- The day log samples the quake feed hourly — an "archived day" is the
  sampled record, labeled as such in the replay panel copy.
