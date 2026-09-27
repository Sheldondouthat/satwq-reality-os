# F12 — Daily auto-briefing with speech narration — integration guide

New files (do not edit existing ones):

- `src/cinematic/briefing.js` — fetch/build/run/speak/button
- `src/cinematic/briefing.test.mjs` — 15 test blocks, fixtures only, no network

No keys, no new deps. Speech is browser `speechSynthesis`.

## 1. "Brief me" button placement

Mount it in the HUD next to the command bar / tour controls — the same row as
`#satwq-nl-command` (see `src/services/INTEGRATION.md`):

```js
import {
  runBriefing,
  createSpeechSynthesisSpeaker,
  mountBriefMeButton,
} from './cinematic/briefing.js';

const speaker = createSpeechSynthesisSpeaker(); // share one per session (mute state lives here)
let activeBriefing = null;

const { unmount } = mountBriefMeButton(
  document.querySelector('#hud-actions-slot'),
  {
    label: 'Brief me',
    onBrief: async () => {
      activeBriefing?.cancel();
      activeBriefing = runBriefing({
        tourDirector,               // the cinematic pack's TourDirector instance (camera is borrowed from its viewer)
        speak: speaker.speak,       // speechSynthesis narration; headless-safe
        onSegment: ({ index, total, segment }) =>
          toast?.(`Briefing ${index + 1}/${total}: ${segment.stop.label}`),
      });
      activeBriefing.done.catch(() => {});
      return activeBriefing;
    },
  },
);
```

- Clicking while a briefing runs is ignored (button disables itself).
- `unmount()` cancels any in-flight briefing and removes the button — call it
  on HUD teardown.
- Camera source resolution: explicit `camera` > `tourDirector._viewer.camera`.
  Passing the TourDirector keeps one camera owner; passing `camera` directly
  (the same adapter from the F7 wiring guide) also works.

## 2. Manual run with live data

```js
import { fetchBriefingEvents, buildBriefing, runBriefing } from './cinematic/briefing.js';

const events = await fetchBriefingEvents(); // /api/events, else USGS + /api/cyclones
const briefing = buildBriefing(events);
console.info(briefing.script); // full narration text
const { cancel, done } = runBriefing({ tourDirector, speak: speaker.speak, briefing });
const results = await done; // [{ index, ok, label }]
```

`fetchBriefingEvents` is defensive per-leg: `/api/events` 404 → USGS
significant-month GeoJSON + `/api/cyclones` in parallel; total outage →
empty bundle, and `buildBriefing` still emits a valid briefing with
`limited: true` and a "limited data" preamble. It never rejects on feed
failure (only on a caller-aborted fetch).

`buildBriefing(events)` is pure and validates its input — fixtures drive the
tests, and malformed quake/cyclone entries are dropped, never fatal.

## 3. Daily auto-briefing

There is no in-app scheduler; drive it from the existing cron/heartbeat
surface (or a simple `setInterval` at boot). Suggested wiring:

```js
// Once per day at 07:00 local, or on first load after 07:00:
const lastBrief = Number(localStorage.getItem('satwq:lastBrief') ?? 0);
const isNewDay = Date.now() - lastBrief > 20 * 3600 * 1000;
if (isNewDay && new Date().getHours() >= 7) {
  localStorage.setItem('satwq:lastBrief', String(Date.now()));
  const { done } = runBriefing({ tourDirector, speak: speaker.speak });
  done.catch(() => {});
}
```

Autoplay policy: browsers block `speechSynthesis` before user interaction.
On a cold auto-run the speaker resolves per-segment after an estimated
duration (camera still flies), and starts voicing after the first click
anywhere — or gate the auto-brief behind the first user gesture.

## 4. NL wiring ("brief me" / "mute")

In the F7 deps builder (`buildNlDeps`, see `src/services/INTEGRATION.md` §2):

```js
briefing: {
  run: () => runBriefing({ tourDirector, camera, speak: speaker.speak }).done,
  setMuted: (m) => speaker.setMuted(m),
},
```

`brief me` → runs the full briefing; `mute`/`unmute` → `speaker.setMuted`.
Mute cancels in-flight speech immediately.

## 5. What each stop looks like

`buildBriefing` returns `{ script, segments, stops, limited, generatedAt }`:

- `segments[i] = { text, stop: { lat, lon, label, heightM } }` — one per
  narration beat: global overview → largest significant quake (30d) →
  top active cyclone → fire-detections overview (CONUS fallback).
- `stops` — the `{ lat, lon, label }` list the task contract requires.
- `runBriefing` flies ~5s per stop (`flyDurationS` option), narrates the
  segment, then advances. `cancel()` stops timers, speech, and the camera
  flight, and `done` resolves with the completed prefix.

## 6. Testing

```sh
node --test src/cinematic/briefing.test.mjs   # 15 blocks, fixtures + fakes, no network
node --test src/services/nlQuery.test.mjs     # F7
node --check src/cinematic/briefing.js         # syntax
```
