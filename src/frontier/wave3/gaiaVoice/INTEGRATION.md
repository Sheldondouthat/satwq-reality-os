# Gaia voice — integration notes (wave3, part C item 3)

Continuous ambient narration, DISTINCT from the on-demand briefing.

## The distinction (deliberate)

- `src/cinematic/briefing.js` — **on-demand**: the user presses "brief me",
  Gaia summarizes current conditions once.
- `src/frontier/wave3/gaiaVoice/` — **ambient**: a background watcher on the
  event-synthesis feed that speaks UNPROMPTED when significant events fire
  (M6.5+ quake, new NWS warning, fireball, high/critical incidents), with
  cooldowns + persistent mute + per-severity voice tuning.

They share nothing but `speechSynthesis`. The control is a separate floating
chip ("🔊 gaia listening" / "🔇 gaia muted") bottom-left, next to — not
replacing — the briefing button.

## 1. `server/providers/local.js` — NO LINES NEEDED

No new `/api/*` routes. The watcher reads `/api/events` (existing) plus
direct keyless feeds (USGS, NWS). Exclusion per PAGES_PORT.md.

## 2. `server/pages/registry.mjs` — EXCLUSION NOTE

No server providers added. Client-side only; the Pages Functions bundle is
untouched (no WASM, no node:fs).

## 3. Mount call for `initFrontier` (in `src/frontier/index.js`)

```js
import { initGaiaVoice } from './wave3/gaiaVoice/index.js';

// inside initFrontier:
// — Wave3/C3 Gaia voice: ambient unprompted narration —
attempt('gaia-voice', () => {
  const cleanup = initGaiaVoice();
  return () => { if (typeof cleanup === 'function') cleanup(); };
});
```

No viewer handle needed. Mute persists via `localStorage['satwq.gaia.muted']`.

## 4. UI strings for theme dictionaries

| Key | Default text |
|---|---|
| `feature.gaiaVoice` | `Planetary voice` |
| `ui.gaia.listening` | `🔊 gaia listening` |
| `ui.gaia.muted` | `🔇 gaia muted` |
| `ui.gaia.test` | `test voice` |

## File map

- `model.js` — classification, cooldowns, dedupe, per-severity voice tuning
- `speaker.js` — speechSynthesis wrapper (feature-detected, voice picker)
- `watcher.js` — 60 s background poll loop over events/USGS/NWS feeds
- `index.js` — `initGaiaVoice()` fail-soft mount + floating controls
- `gaiaVoice.test.mjs` — 11 tests, all passing
