# Theme String-Key Registry

Every theme manifest in `themes.js` must define **all 34 required keys** below.
`engine.js` resolves labels through `t(key)` with this fallback chain:

1. active theme's `strings[key]`
2. the canonical English default in `engine.js` (`BASE_STRINGS`)
3. the raw key itself (never throws, never renders `undefined`)

Feature code built by other workers adopts these keys instead of hard-coded
labels. New keys may be added to a theme's dictionary at any time, but keys
listed here are the **required set** — `themes.test.mjs` fails any manifest
that omits one.

## Key list

| Key | Canonical default | Notes |
|---|---|---|
| `app.title` | `SATWQ // God's Eye` | HUD masthead |
| `app.tagline` | `Planetary awareness console` | Subtitle under the masthead |
| `layer.firms` | `Wildfires (FIRMS)` | Fire detections |
| `layer.earthquakes` | `Earthquakes (USGS)` | Seismic events |
| `layer.flights` | `Aircraft (ADS-B)` | Flights |
| `layer.vessels` | `Vessels (AIS)` | Ships |
| `layer.satellites` | `Satellites (TLE)` | Orbital objects |
| `layer.weather` | `Weather (GIBS)` | Weather overlays |
| `layer.cyclones` | `Tropical cyclones` | Cyclone tracks |
| `layer.volcanoes` | `Volcanoes` | Volcanic activity |
| `layer.aurora` | `Aurora` | Auroral ovals |
| `layer.lightning` | `Lightning` | Strike detections |
| `layer.smoke` | `Smoke (HMS)` | Smoke plumes |
| `layer.radar` | `Radar (RainViewer)` | Precipitation radar |
| `feature.events` | `Event synthesis feed` | New feature 1 |
| `feature.dvr` | `Planetary DVR` | New feature 2 — time scrubber |
| `feature.seismic` | `Seismic wavefronts` | New feature 3 |
| `feature.lightning` | `Lightning layer` | New feature 4 |
| `feature.ovation` | `OVATION aurora` | New feature 5 |
| `feature.skyAnomaly` | `Sky anomaly alerts` | New feature 6 |
| `feature.nlq` | `Natural-language queries` | New feature 7 — ask the planet |
| `feature.sonification` | `Sonification` | New feature 8 — data as audio |
| `feature.forecastFireSpread` | `Fire-spread forecast` | New feature 9a |
| `feature.forecastHurricaneCones` | `Hurricane cone forecast` | New feature 9b |
| `feature.forecastAsh` | `Volcanic ash forecast` | New feature 9c |
| `feature.notebook` | `Planetary notebook` | New feature 10 |
| `feature.indoorTwin` | `Indoor twin view` | New feature 11 |
| `feature.autoBriefing` | `Daily auto-briefing` | New feature 12 |
| `severity.low` | `Low` | Severity band |
| `severity.moderate` | `Moderate` | Severity band |
| `severity.high` | `High` | Severity band |
| `severity.critical` | `Critical` | Severity band |
| `incident.label` | `Incident` | The theme's word for "incident" |
| `alert.label` | `Alert` | The theme's word for "alert" |

## Adoption path for feature code

```js
import { t } from './themes/engine.js';

// BAD — hard-coded label, immune to theming
panel.title = 'Event synthesis feed';

// GOOD — resolves through the active theme, falls back to the default
panel.title = t('feature.events');
```

Severity rendering:

```js
import { t } from './themes/engine.js';
badge.textContent = t(`severity.${sev}`); // sev in low|moderate|high|critical
```

On `satwq:themechange` (dispatched on `document` by `applyTheme`), feature
code should re-run its labeling pass so already-rendered UI picks up the new
terminology:

```js
document.addEventListener('satwq:themechange', () => renderLabels());
```

## Rules

- Values must never change — themes reword, recolor, and restyle only.
- Layer keys must keep the data source identifiable (e.g. keep `(FIRMS)`,
  `(USGS)`, `(AIS)` provenance) even in irreverent themes.
- Severity keys must preserve the 4-band ordering semantics (low → critical).
