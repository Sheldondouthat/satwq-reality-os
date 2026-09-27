# Theme Pack — Integration Guide

All theme code lives in `src/themes/` and is **additive only**: no existing
file was modified. Wire it in with three small snippets.

## 1. Engine init (boot)

Call once, early — before first paint if possible. It restores the persisted
choice (or the default `batcave` skin) and applies CSS vars + `data-theme`.

```js
// src/main.js (or your boot module)
import { initTheme } from './themes/engine.js';

initTheme(); // restores localStorage 'satwq.theme.id', applies palette + terminology
```

What `initTheme()` does:
- reads `localStorage['satwq.theme.id']` (guarded `try/catch`)
- calls `applyTheme(id)`, which:
  - sets `--theme-bg / --theme-panel / --theme-accent / --theme-text /`
    `--theme-warn / --theme-ok / --theme-danger / --theme-info /`
    `--theme-font-ui / --theme-font-mono` on `document.documentElement`
  - sets `data-theme="<id>"` on `<html>`
  - injects the effects stylesheet + overlay container (idempotent)
  - persists the id and dispatches `satwq:themechange` on `document`

## 2. Switcher mounting (HUD)

Mount wherever the HUD chrome lives (e.g. beside the layer panel). The
switcher is a self-styled grid of 14 tiles; clicking a tile calls
`applyTheme()` instantly.

```js
// wherever the HUD is assembled (e.g. in the HUD init, after DOM is ready)
import { mountThemeSwitcher } from './themes/switcher.js';

mountThemeSwitcher('#hud-theme-slot');          // selector or element
// or: mountThemeSwitcher(el, { label: 'SKIN' });
```

It marks the active tile (`aria-selected` + `.is-active`) and re-marks on
every `satwq:themechange`, so multiple switchers stay in sync.

## 3. Terminology in feature code

Never hard-code a label that a theme rewords. Use `t(key)` with keys from
`KEYS.md`; unknown keys fall back to the canonical English default, and
totally unknown keys return the key itself (never `undefined`).

```js
import { t } from './themes/engine.js';

// Panel titles
panel.title = t('feature.events');        // "Symptom log" in Med-Bay, "Event synthesis feed" default

// Layer toggles
toggle.label = t('layer.firms');          // keeps (FIRMS) provenance in every theme

// Severity badges (sev ∈ low|moderate|high|critical)
badge.textContent = t(`severity.${sev}`); // "GO"/"NO-GO"/"ABORT" in Apollo, "Stable"… in Med-Bay

// Incident / alert nouns
header.textContent = `${count} ${t('incident.label')}s`;
```

Re-render labels when the theme changes:

```js
import { onThemeChange } from './themes/engine.js';

onThemeChange(() => renderLabels()); // or: document.addEventListener('satwq:themechange', renderLabels)
```

## CSS hooks for your own components

Theme-aware components should read the custom properties, never hard-code
colors:

```css
.my-panel {
  background: var(--theme-panel);
  color: var(--theme-text);
  border: 1px solid var(--theme-accent);
  font-family: var(--theme-font-ui);
}
.my-panel .mono { font-family: var(--theme-font-mono); }
.my-panel .danger { color: var(--theme-danger); }
```

Per-theme overrides are possible via the attribute:

```css
[data-theme="pipboy"] .my-panel { border-width: 3px; }
```

## Effects

Effects are pure-CSS overlays driven by `[data-theme="<id>"]` selectors in the
injected stylesheet (`#satwq-theme-fx`, `pointer-events: none`, `z-index: 9990`).
Flags per theme: `scanlines`, `vignette`, `noise`, `phosphorGlow`,
`hologramFlicker`, `glitch`. All are opacity/gradient layers or
compositor-friendly animations — no canvas, no per-frame JS, no globe perf
cost. If an effect ever proves heavy on a target device, delete its flag from
the manifest's `effects` array and it degrades to a static palette swap.

## Adding a theme or a key

1. Append a manifest to `THEMES` in `themes.js` (copy an existing one).
   Required: `id`, `name`, `tagline`, `vars` (bg/panel/accent/text/warn/ok +
   danger/info/fonts), `effects` (subset of the six flags), `chrome` notes,
   and `strings` covering **all 34 keys** in `KEYS.md`.
2. `node src/themes/themes.test.mjs` — the completeness test fails on any
   missing key.
3. New string keys: add the canonical default to `BASE_STRINGS` in
   `engine.js`, document it in `KEYS.md`, and add it to `REQUIRED_KEYS` if
   every theme must define it.

## Files

| File | Purpose |
|---|---|
| `src/themes/engine.js` | `applyTheme` / `getTheme` / `listThemes` / `t` / `initTheme` / persistence / effects injection |
| `src/themes/themes.js` | 14 manifests (medbay, batcave, garage, noir, lcars, pipboy, jarvis, nerv, nightcity, apollo, weyland, synthwave, scp, tron) |
| `src/themes/switcher.js` | `createThemeSwitcher` / `mountThemeSwitcher` HUD control |
| `src/themes/KEYS.md` | 34-key string registry + adoption path |
| `src/themes/themes.test.mjs` | 21 tests (node:test), all passing |
| `src/themes/INTEGRATION.md` | this file |

No new dependencies. No network calls. No keys. Data values untouched —
only words, palette, typography, and chrome.
