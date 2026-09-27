# INTEGRATION — whatIf (wave3 sci-fi B #3)

**Status:** client module complete, 14/14 tests passing. No shared-file edits
made by the author; the parent applies the lines below.

## 1. server/providers/local.js — NOTHING (exclusion note)

Pure client-side math (model.js) — no new data, no upstream, no provider.
Per PAGES_PORT.md conventions this is a deliberate client-only feature.

## 2. server/pages/registry.mjs — NOTHING

No `/api/*` routes.

## 3. initFrontier mount call (src/frontier/index.js)

Static import (top of file):

```js
import { init as initWhatIf } from './wave3/whatIf/index.js';
```

Attempt block — place after the ocean-twin block:

```js
  // — sci-fi B3 what-if simulator —
  attempt('what-if', () => {
    const s = section(t('feature.whatIf'));
    dock.appendChild(s);
    const sim = initWhatIf(viewer, { mount: s });
    if (!sim) return () => {};
    return () => sim.destroy();
  });
```

## 4. Theme dictionary strings (src/themes/engine.js)

```js
  'feature.whatIf': 'What-if simulator (effect rings)',
```

## Physics honesty (for the record)

- Overpressure radii: Glasstone–Dolan cube-root scaling for surface bursts
  (R_20psi ≈ 0.28·W^⅓, R_5psi ≈ 0.62·W^⅓, R_1psi ≈ 1.6·W^⅓ km, W in kt).
  Test-anchored: 1 Mt → 2.8 / 6.2 / 16.0 km.
- Thermal (3rd-degree): R ≈ 1.2·W^0.41 km — test asserts the known crossover
  (blast outranges burns at 1 kt; thermal dominates at 1 Mt).
- Asteroid: E = ½mv²; crater D ≈ 1.8·E_Mt^0.294 km (simplified
  Schmidt–Holsapple, dense rock). Chelyabinsk-class check in tests (~0.46 Mt).
- Tsunami: c = √(g·H), H = 4000 m → ≈ 713 km/h; arrival rings at 1/2/4/8/12 h.
- The `WHATIF_HONESTY` banner is always rendered: "Simplified educational
  model — not a hazard assessment."
