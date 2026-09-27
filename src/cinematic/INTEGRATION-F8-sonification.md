# F8 — Data sonification · integration guide

Ships as **new files only**: `src/cinematic/sonification.js` + `sonification.test.mjs`. Nothing existing was edited (`ambientEngine.js` is read-only by constraint). See also `src/layers/lightning/INTEGRATION.md` (F4) for the lightning-layer side of the wiring.

## API

```js
import { initSonification } from './sonification.js'; // alias `init` also exported
const son = initSonification({ getAudioContext: () => audioCtx, volume: 0.8 });

son.setEnabled(true);        // master toggle (returns new state)
son.toggle();
son.setVolume(0.6);          // user volume 0..1 → sonification bus only
son.quake({ magnitude, lat, lon });       // deep rumble, scaled by magnitude
son.lightningStrike({ lat, lon });        // short bandpass tick
son.issPass({ lat, lon });                // soft C5→E5→G5 chime arpeggio
son.destroy();               // disconnects bus; NEVER closes the shared context
```

## Sound design (pure, unit-testable mappings)

| Event | Mapping | Voice |
|---|---|---|
| `quake({magnitude})` | `quakeSoundParams(m)`: freq 45.5→28.6 Hz, duration 1.7→3.8 s, gain 0.16→0.46 as M2.5→M9 (clamped) | sine osc + exp-decay envelope |
| `lightningStrike()` | `lightningSoundParams()`: 90 ms bandpass noise @ 2600 Hz, Q 7 | buffer noise → biquad → envelope |
| `issPass()` | `issChimeParams(i)`: C5/E5/G5, staggered 220 ms, 1.1 s decay, gain 0.1 | 3 sine oscs |

- **Stereo placement**: `panForLon(lon)` maps −180→full left, +180→full right via `StereoPannerNode` (skipped if unavailable).
- **Volume**: dedicated sonification gain bus → destination; `setVolume` scales only this bus, never the ambient bed.
- **Throttling**: `SONIFICATION_MAX_VOICES` (16); oldest voices stopped first.
- **Degradation**: OFF by default; every event method returns `false` (no-op) when disabled, when `getAudioContext()` returns null, or when the provider throws. Never throws in production.

## Sharing the AudioContext with AmbientEngine (zero edits to ambientEngine.js)

`AmbientEngine` keeps its context private (`this._ctx`, no accessor) and this build may not edit it. Two wiring options — **A is recommended**:

**A. Create the context in the app, share it with both** (in `src/cinematic/index.js`, where `new AmbientEngine()` is constructed today):

```js
import { initSonification } from './sonification.js';

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const ambient = new AmbientEngine({ createContext: () => audioCtx }); // reuses, never competes
const son = initSonification({ getAudioContext: () => audioCtx, volume: 0.8 });

const cinematic = { tour, ambient, sonification: son };
```

One context, two graphs (ambient bed + sonification bus), no competition; autoplay policy still satisfied because the context resumes inside a user gesture (the ambient/sonification toggle).

**B. Future one-liner** (requires editing `ambientEngine.js`, currently read-only): add a `getContext()` accessor returning `this._ctx` (creating it if needed), then `initSonification({ getAudioContext: () => ambient.getContext() })`.

## HUD toggle (snippet for the parent)

```js
// in the HUD/controls wiring:
sonToggleButton.onclick = () => {
  const on = son.toggle();           // or son.setEnabled(true/false)
  sonToggleButton.classList.toggle('active', on);
};
volumeSlider.oninput = (e) => son.setVolume(Number(e.target.value)); // 0..1
```

## Event wiring (for the parent — suggested sources, no existing files touched by this build)

- **Quakes** — shape matches USGS rows (`{mag, lat, lon}` from `src/layers/earthquakes/records.js`). Suggested: in the earthquakes update path (or a poller over the layer's analyst records), call `son.quake({ magnitude: row.mag, lat: row.lat, lon: row.lon })` for new events, e.g. M ≥ 4.5 to avoid chatter.
- **Lightning** — zero-edit: pass `onFlash` when creating the layer (see `src/layers/lightning/INTEGRATION.md`):
  ```js
  createApplicationLightning({ source: sources.lightning, sonification: son })
  // wrapper maps onFlash → son.lightningStrike; consider intensity gating:
  // onFlash: (s) => { if (s.intensity > 0.55) son.lightningStrike(s); }
  ```
- **ISS passes** — the satellites layer tracks ISS via CelesTrak TLEs (`src/layers/satellites/`). Suggested: a lightweight poller (e.g. every 5 s) that reads the tracked ISS position from the satellites layer's public API and calls `son.issPass({ lat, lon })` on a rising edge (e.g. when it enters a new 30° longitude band, or when tracking is enabled). Check `src/layers/satellites/tracking.js` / `index.js` for the exact accessor when wiring.

## Test results

- `node --check`: both files parse.
- `node --test sonification.test.mjs`: **12/12 pass** — param-mapping scaling/clamping, stagger timing, pan mapping, disabled/contextless no-ops, bus gain + volume, voice-cap pruning, destroy-never-closes-shared-context.
