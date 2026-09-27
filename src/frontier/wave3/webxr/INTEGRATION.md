# WebXR mode — integration notes (wave3, part C item 2)

"Step inside the planet": an immersive 360 viewer with live data sprites.

## Honest scope (v1)

This is an immersive live-data **diorama**, not the Cesium globe ported to
XR. The viewer renders a hand-rolled WebGL inverted sphere textured with an
equirectangular panorama (starfield + graticule + live event sprites from
`/api/events` and the USGS quake feed). Head-tracked look-around only; no
controllers, no locomotion, no terrain/imagery tiles. A full Cesium→XR port
is explicitly out of scope and is labeled as such on the entry button.

Quest-browser compatible: uses only the standard WebXR `immersive-vr` flow
plus plain WebGL1. When immersive-vr is unavailable (desktop, plain tab),
the same panorama opens in a fullscreen drag-to-look 360 fallback viewer.

## 1. `server/providers/local.js` — NO LINES NEEDED

No new `/api/*` routes. Sprites come from existing routes/feeds
(`/api/events`, USGS direct). Exclusion per PAGES_PORT.md.

## 2. `server/pages/registry.mjs` — EXCLUSION NOTE

No server providers added. Client-side only; the Pages Functions bundle is
untouched (no WASM, no node:fs, nothing new for esbuild to trace).

## 3. Mount call for `initFrontier` (in `src/frontier/index.js`)

```js
import { initWebXR } from './wave3/webxr/index.js';

// inside initFrontier:
// — Wave3/C2 WebXR: inside-the-planet viewer (v1 diorama) —
attempt('webxr', () => {
  const cleanup = initWebXR();
  return () => { if (typeof cleanup === 'function') cleanup(); };
});
```

`initWebXR()` needs no viewer handle (it does not touch Cesium); it mounts
its own floating button. The panorama repaints every 30 s with fresh sprites.

## 4. UI strings for theme dictionaries

| Key | Default text |
|---|---|
| `feature.webxr` | `Inside the planet` |
| `ui.webxr.enter` | `◉ step inside the planet (v1)` |
| `ui.webxr.fallbackTitle` | `◈ inside the planet — 360 viewer` |
| `ui.webxr.fallbackNote` | `(non-XR fallback; drag to look around)` |

## File map

- `math.js` — pure projection math (lonLat→vec3, equirect UV, eye viewports, drag-look)
- `dataSprites.js` — incident/quake → sprite mapping + fail-soft fetcher
- `panorama.js` — equirect panorama painter (starfield, graticule, sprites)
- `xrSession.js` — immersive-vr session manager (hand-rolled WebGL sphere, stereo)
- `fallback.js` — fullscreen 360 drag-to-look viewer (non-XR)
- `index.js` — `initWebXR()` fail-soft mount
- `webxr.test.mjs` — 13 tests, all passing
