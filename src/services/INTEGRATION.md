# F7 — Natural-language globe queries — integration guide

New files (do not edit existing ones):

- `src/services/nlQuery.js` — parser, executor, providers
- `src/services/nlQuery.test.mjs` — 19 test blocks, 40+ parse cases, all offline

## 1. Command-bar input mounting

Mount wherever the HUD search box lives (next to it is ideal — same muscle
memory). Plain DOM, no framework:

```js
import { parseQuery, executePlan } from './services/nlQuery.js';
import { buildNlDeps } from './services/nlQueryWiring.js'; // you write this — see §2

const input = document.createElement('input');
input.id = 'satwq-nl-command';
input.type = 'text';
input.placeholder = 'Try "show wildfires" or "fly to Tokyo"';
input.setAttribute('aria-label', 'Natural language globe command');
document.querySelector('#hud-search-slot')?.appendChild(input);

input.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const text = input.value;
  input.value = '';
  try {
    const { plan } = parseQuery(text); // sync, keyless, never needs network
    const results = await executePlan(plan, buildNlDeps());
    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) console.warn('[nlQuery]', failed);
  } catch (error) {
    console.error('[nlQuery]', error); // parse/execute never throw by design; this is belt-and-braces
  }
});
```

Unknown queries never crash: they produce a `say` step with
`"I didn't understand — try 'show wildfires' or 'fly to Tokyo'."`. Wire
`deps.say` to a HUD toast so the user actually sees it.

## 2. Deps object construction (`nlQueryWiring.js` — new file, yours to write)

```js
import { LAYER_SYNONYMS } from './services/nlQuery.js';
import { geocodeKeyless } from '../keylessGeocoder.js';
import { runBriefing, createSpeechSynthesisSpeaker } from '../cinematic/briefing.js';

export function buildNlDeps({ viewer, layerManager, tourDirector, toast }) {
  // Layers: the canonical ids are Object.keys(LAYER_SYNONYMS) — exactly the
  // src/layers/* directory names.
  const layers = {};
  for (const id of Object.keys(LAYER_SYNONYMS)) {
    layers[id] = {
      show: () => layerManager.setEnabled(id, true, { origin: 'nl-query' }),
      hide: () => layerManager.setEnabled(id, false, { origin: 'nl-query' }),
      toggle: () =>
        layerManager.setEnabled(id, !layerManager.isEnabled(id), { origin: 'nl-query' }),
    };
  }

  // Camera: translate the view descriptor to Cesium (same convention the
  // TourDirector's destinationFor hook uses).
  const camera = {
    flyTo: ({ longitude, latitude, heightM, headingDeg = 0, pitchDeg = -60, label }) =>
      new Promise((resolve) => {
        viewer.camera.flyTo({
          destination: Cesium.Cartesian3.fromDegrees(longitude, latitude, heightM),
          orientation: {
            heading: Cesium.Math.toRadians(headingDeg),
            pitch: Cesium.Math.toRadians(pitchDeg),
            roll: 0,
          },
          duration: 4,
          complete: () => resolve({ ok: true, label }),
          cancel: () => resolve({ ok: false, label }),
        });
      }),
    zoom: (dir) => {
      const carto = viewer.camera.positionCartographic;
      const height = carto.height;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          Cesium.Math.toDegrees(carto.longitude),
          Cesium.Math.toDegrees(carto.latitude),
          dir === 'in' ? height / 2 : height * 2,
        ),
        duration: 1.5,
      });
    },
  };

  const speaker = createSpeechSynthesisSpeaker();

  return {
    layers,
    camera,
    geocoder: (q) => geocodeKeyless(q), // {lat,lng,label,types} — parsed natively
    tour: tourDirector, // { start(), stop() } — the cinematic pack's instance
    briefing: {
      run: () =>
        runBriefing({ tourDirector, camera, speak: speaker.speak }).done,
      setMuted: (m) => speaker.setMuted(m),
    },
    say: (text) => toast?.(text) ?? console.info('[nlQuery]', text),
  };
}
```

Notes:

- `geocodeKeyless` returns `null` on miss — `executePlan` turns that into a
  spoken "I couldn't find '<place>'" and continues the plan.
- `tour` may be `null` (tour not constructed yet): `executePlan` degrades the
  step to a spoken notice instead of throwing.
- `briefing.run` returns the `done` promise, so `executePlan` awaits the whole
  briefing before finishing the plan.

## 3. Supported utterances (rule-based v1)

| Say | Does |
|---|---|
| `show wildfires` / `hide traffic` / `toggle satellites` | layer show/hide/toggle — synonyms cover all 41 `src/layers/*` ids (`planes`→flights, `ships`→vessels, `northern lights`→aurora, …) |
| `show earthquakes and volcanoes` | multi-layer; `hide traffic and show wildfires` keeps per-clause verbs |
| `fly to Tokyo` / `go to Paris` / `where is Everest` | keyless geocode (Photon) → camera flight, height picked from place type |
| `zoom in` / `zoom out` | camera zoom |
| `start tour` / `stop tour` | TourDirector start/stop |
| `brief me` / `what's happening` | F12 briefing (see `src/cinematic/INTEGRATION.md`) |
| `mute` / `unmute` | briefing narration mute |
| `help` | lists example commands |

## 4. Provider upgrade path (no key needed for v1)

```js
import { createLLMProvider, parseQueryAsync } from './services/nlQuery.js';

// v1 (default): ruleBasedProvider() — keyless, offline, synchronous.
const provider = createLLMProvider();

// Later: remote LLM. Inert without a key — returns a degraded "unknown"
// result instead of failing, so the UI keeps working.
const llm = createLLMProvider({ name: 'openai', apiKey: null });
const result = await parseQueryAsync('show wildfires near me', { provider: llm });
await executePlan(result.plan, deps);
```

`parseQuery` throws a clear `TypeError` if handed an async provider (it refuses
*before* invoking `parse`, so no stray network request fires); use
`parseQueryAsync` for remote providers.
