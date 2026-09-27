/**
 * nlQuery.js — F7 natural-language globe queries (keyless rule-based v1).
 *
 * Public surface:
 *   parseQuery(text, { provider }?)  → { intent, entities, plan, provider }
 *   parseQueryAsync(text, { provider }) → Promise of the same (for remote providers)
 *   executePlan(plan, deps)          → Promise<[{ step, ok, error? }]>; never throws
 *   ruleBasedProvider()             → the default, keyless, fully-offline parser
 *   openAIProvider({ apiKey }?)     → documented upgrade path; inert without a key
 *   createLLMProvider(options?)     → provider factory (rule-based unless configured)
 *   LAYER_SYNONYMS                  → canonical layer-id → synonym list
 *   resolveLayerId(text)            → canonical layer id or null
 *   HELP_HINT                       → the "I didn't understand" response text
 *
 * deps for executePlan:
 *   {
 *     layers:  { [layerId]: { show(), hide(), toggle() } },
 *     camera:  { flyTo(view), zoom?(dir), getPosition?() },
 *     geocoder: fn(query) | { geocode(query) } → place | { place } | null
 *     tour:    { start(), stop() },
 *     briefing:{ run?(), setMuted?(bool) } | fn,
 *     say:     fn(text) — optional narration/feedback sink
 *   }
 *
 * Every value that reaches executePlan is injected, so tests run with zero
 * network. Unknown queries never crash: they produce a `say` step with a
 * helpful hint instead.
 */

export const HELP_HINT =
  "I didn't understand — try 'show wildfires' or 'fly to Tokyo'.";

/**
 * Canonical layer ids (src/layers/*) → the words users actually say.
 * Order matters inside resolveLayerId: longer synonyms are tried first so
 * "sea surface temperature" wins over "temperature".
 */
export const LAYER_SYNONYMS = Object.freeze({
  firms: [
    'wildfires', 'wildfire', 'forest fires', 'forest fire', 'active fires',
    'fire detections', 'hotspots', 'hotspot', 'fires', 'fire', 'burning',
  ],
  earthquakes: ['earthquakes', 'earthquake', 'quakes', 'quake', 'seismic'],
  cyclones: [
    'tropical storms', 'tropical storm', 'hurricanes', 'hurricane',
    'typhoons', 'typhoon', 'cyclones', 'cyclone', 'storms', 'storm',
  ],
  volcanoes: ['volcanoes', 'volcano', 'eruptions', 'eruption', 'lava'],
  weather: ['weather', 'forecast'],
  wind: ['wind map', 'winds', 'wind'],
  spaceWeather: [
    'space weather', 'solar weather', 'solar storm', 'geomagnetic',
    'kp index',
  ],
  flights: [
    'airplanes', 'airplane', 'planes', 'plane', 'commercial flights',
    'flights', 'flight', 'air traffic',
  ],
  aircraft: ['aircraft'],
  localAdsb: ['local adsb', 'adsb'],
  vessels: [
    'ships', 'ship', 'vessels', 'vessel', 'boats', 'boat', 'marine traffic',
    'ais traffic', 'ais',
  ],
  satellites: ['satellites', 'satellite', 'iss', 'starlink'],
  launches: ['rocket launches', 'launches', 'launch', 'rockets', 'rocket'],
  meteors: ['meteor shower', 'meteors', 'meteor'],
  aurora: [
    'northern lights', 'southern lights', 'aurora borealis',
    'aurora australis', 'aurora',
  ],
  moon: ['moon', 'lunar'],
  terminator: [
    'day night line', 'day/night line', 'day night terminator',
    'terminator', 'day night', 'night side',
  ],
  gibsTruecolor: [
    'true color imagery', 'truecolor imagery', 'true color', 'truecolor',
    'satellite imagery',
  ],
  gibsNightlights: ['night lights', 'city lights'],
  gibsChlorophyll: ['chlorophyll', 'ocean color', 'plankton'],
  gibsSst: ['sea surface temperature', 'ocean temperature', 'sst'],
  rainviewerRadar: [
    'rain radar', 'precipitation radar', 'precipitation', 'weather radar',
    'radar', 'rain',
  ],
  rainviewerSatellite: ['cloud satellite', 'satellite clouds', 'clouds'],
  hmsSmoke: ['wildfire smoke', 'smoke plumes', 'hms smoke', 'smoke'],
  perimeters: ['fire perimeters', 'burn scars', 'perimeters', 'burn area'],
  cctv: ['cctv', 'traffic cameras', 'security cameras', 'cameras', 'camera'],
  traffic: ['road traffic', 'traffic'],
  transit: ['public transit', 'transit', 'buses', 'bus'],
  tides: ['tides', 'tide'],
  buoys: ['ocean buoys', 'buoys', 'buoy'],
  submarineCables: [
    'submarine cables', 'undersea cables', 'internet cables',
    'submarine cable',
  ],
  radio: ['ham radio', 'radio stations', 'radio'],
  bikeshare: ['bike share', 'bikeshare', 'bikes', 'bike'],
  alpr: ['license plate readers', 'plate readers', 'alpr', 'license plates'],
  installations: ['military bases', 'installations', 'bases'],
  military: ['military activity', 'military'],
  awareness: ['awareness'],
  directions: ['directions', 'routing', 'navigation', 'route'],
  imageryTile: ['imagery tile'],
  recentImagery: ['recent imagery', 'latest imagery'],
  osmBuildings3d: ['3d buildings', 'buildings 3d', 'buildings'],
});

/** Flattened, longest-first (synonym, layerId) table for substring matching. */
const SYNONYM_TABLE = (() => {
  const rows = [];
  for (const [id, synonyms] of Object.entries(LAYER_SYNONYMS)) {
    for (const synonym of synonyms) rows.push([synonym, id]);
  }
  rows.sort((a, b) => b[0].length - a[0].length);
  return Object.freeze(rows);
})();

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find every canonical layer id mentioned in the text (deduped, in
 * longest-match order). Multi-word synonyms with escaped punctuation.
 */
export function resolveLayerIds(text) {
  const found = [];
  const seen = new Set();
  for (const [synonym, id] of SYNONYM_TABLE) {
    if (seen.has(id)) continue;
    const pattern = new RegExp(
      `(^|[^a-z0-9])${escapeRegExp(synonym)}([^a-z0-9]|$)`,
      'i',
    );
    if (pattern.test(text)) {
      found.push(id);
      seen.add(id);
    }
  }
  return found;
}

/** First (best) layer id mentioned, or null. */
export function resolveLayerId(text) {
  return resolveLayerIds(text)[0] ?? null;
}

// Kept for callers that built against the earlier single-match helper name.
export { resolveLayerId as resolveLayer };

const SHOW_VERBS = /\b(show|display|enable|turn on|switch on|activate|add|bring up)\b/;
const HIDE_VERBS = /\b(hide|disable|turn off|switch off|deactivate|remove|clear|dismiss)\b/;
const TOGGLE_VERBS = /\b(toggle|flip|switch)\b/;

const FLY_LEAD =
  /^(?:fly|go|take me|navigate|pan|jump|travel)(?:\s+to)?\s+(.+)$/;
const FLY_ALT = /^(?:where is|where's|show me|find|locate|center on)\s+(.+)$/;
const ZOOM_IN = /\b(zoom in|zoom closer|closer|magnify)\b/;
const ZOOM_OUT = /\b(zoom out|zoom away|further|farther|pull back)\b/;
const TOUR_START = /\b(start|begin|launch)(?:\s+the)?\s+tour\b/;
const TOUR_STOP = /\b(stop|end|quit|exit)(?:\s+the)?\s+tour\b/;
const BRIEF =
  /\b(brief me|daily brief|briefing|morning brief|give me the brief|what'?s happening|news|headlines)\b/;
const UNMUTE = /\b(unmute|unsilence|sound on|turn (?:the )?sound on)\b/;
const MUTE = /\b(mute|silence|quiet|sound off|turn (?:the )?sound off)\b/;
const HELP = /\b(help|what can (you|i do)|commands|command list)\b/;

function stripNoise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[?!.;:]+$/g, '')
    .trim();
}

/**
 * Rule-based parse of one query. Pure and synchronous — no network, no keys.
 * Returns { intent, entities, plan }.
 */
export function ruleBasedParse(rawText) {
  const text = stripNoise(rawText);
  const empty = { intent: 'unknown', entities: {}, plan: sayPlan(HELP_HINT) };

  if (!text) return empty;

  // mute before unmute would misfire on "unmute" — check the longer form first.
  if (UNMUTE.test(text)) {
    return {
      intent: 'unmute',
      entities: { muted: false },
      plan: [{ type: 'mute', muted: false }],
    };
  }
  if (MUTE.test(text)) {
    return {
      intent: 'mute',
      entities: { muted: true },
      plan: [{ type: 'mute', muted: true }],
    };
  }
  if (TOUR_START.test(text)) {
    return {
      intent: 'tour',
      entities: { op: 'start' },
      plan: [{ type: 'tour', op: 'start' }],
    };
  }
  if (TOUR_STOP.test(text)) {
    return {
      intent: 'tour',
      entities: { op: 'stop' },
      plan: [{ type: 'tour', op: 'stop' }],
    };
  }
  if (BRIEF.test(text)) {
    return {
      intent: 'brief',
      entities: {},
      plan: [{ type: 'brief' }],
    };
  }
  if (ZOOM_IN.test(text) && !/layer|show|hide/.test(text)) {
    return {
      intent: 'zoom',
      entities: { direction: 'in' },
      plan: [{ type: 'zoom', direction: 'in' }],
    };
  }
  if (ZOOM_OUT.test(text) && !/layer|show|hide/.test(text)) {
    return {
      intent: 'zoom',
      entities: { direction: 'out' },
      plan: [{ type: 'zoom', direction: 'out' }],
    };
  }
  if (HELP.test(text)) {
    return {
      intent: 'help',
      entities: {},
      plan: sayPlan(
        "Try 'show wildfires', 'hide traffic', 'fly to Tokyo', 'zoom in', 'start tour', or 'brief me'.",
      ),
    };
  }

  // Layer intents: verb + one or more layer mentions. The query is split on
  // "and"/commas so each clause carries its own verb ("hide traffic and show
  // wildfires" must not hide both); a verbless clause inherits the previous
  // clause's op ("hide traffic and weather" hides both).
  const layerIds = resolveLayerIds(text);
  if (layerIds.length > 0) {
    const opOf = (segment) => {
      if (TOGGLE_VERBS.test(segment)) return 'toggle';
      if (HIDE_VERBS.test(segment)) return 'hide';
      if (SHOW_VERBS.test(segment)) return 'show';
      return null;
    };
    const segments = text.split(/\s+and\s+|,/).map((s) => s.trim()).filter(Boolean);
    const clauses = segments.length > 0 ? segments : [text];
    const planSteps = [];
    const seen = new Set();
    let inheritedOp = opOf(text) ?? 'show';
    for (const clause of clauses) {
      const ids = resolveLayerIds(clause);
      if (ids.length === 0) continue;
      const op = opOf(clause) ?? inheritedOp;
      inheritedOp = op;
      for (const layer of ids) {
        const key = `${op}:${layer}`;
        if (seen.has(key)) continue;
        seen.add(key);
        planSteps.push({ type: 'layer', layer, op });
      }
    }
    const finalPlan = planSteps.length > 0
      ? planSteps
      : layerIds.map((layer) => ({ type: 'layer', layer, op: inheritedOp }));
    const ops = new Set(finalPlan.map((s) => s.op));
    return {
      intent: 'layer',
      entities: {
        layers: finalPlan.map((s) => s.layer),
        op: ops.size === 1 ? finalPlan[0].op : 'mixed',
      },
      plan: finalPlan,
    };
  }

  // Fly-to intents.
  const flyMatch = text.match(FLY_LEAD) || text.match(FLY_ALT);
  if (flyMatch) {
    const place = flyMatch[1].trim();
    if (place) {
      return {
        intent: 'fly',
        entities: { place },
        plan: [{ type: 'fly', place }],
      };
    }
  }

  return empty;
}

function sayPlan(text) {
  return [{ type: 'say', text }];
}

/** The default keyless provider: full v1 logic, runs anywhere. */
export function ruleBasedProvider() {
  return {
    name: 'rule-based',
    kind: 'local',
    keyless: true,
    parse: (text) => ruleBasedParse(text),
  };
}

/**
 * Upgrade path: a remote LLM provider. Inert without a key — it refuses to
 * parse rather than burning a request or inventing an answer. When a key is
 * present it asks the model for a JSON plan in this module's step schema and
 * validates every step before returning it.
 */
export function openAIProvider({ apiKey = null, model = 'gpt-4o-mini' } = {}) {
  return {
    name: 'openai',
    kind: 'remote',
    keyless: false,
    async: true, // parse() returns a promise — use parseQueryAsync, never parseQuery
    async parse(text) {
      if (!apiKey) {
        return {
          intent: 'unknown',
          entities: {},
          plan: sayPlan(
            'The AI parser needs an API key, which is not configured — ' +
              'the built-in rule-based parser is handling this instead.',
          ),
          provider: 'openai',
          degraded: true,
        };
      }
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            {
              role: 'system',
              content:
                'Translate the user query into a JSON plan for a 3D globe. ' +
                'Return {"intent": string, "entities": object, "plan": array}. ' +
                'Plan steps are one of: ' +
                '{"type":"layer","layer":id,"op":"show"|"hide"|"toggle"}, ' +
                '{"type":"fly","place":string}, ' +
                '{"type":"zoom","direction":"in"|"out"}, ' +
                '{"type":"tour","op":"start"|"stop"}, ' +
                '{"type":"brief"}, {"type":"mute","muted":boolean}, ' +
                '{"type":"say","text":string}. ' +
                'Valid layer ids: ' +
                Object.keys(LAYER_SYNONYMS).join(', ') +
                '. If unsure, return intent "unknown" with a single say step.',
            },
            { role: 'user', content: String(text ?? '') },
          ],
        }),
      });
      if (!response.ok) throw new Error(`openai parse failed: ${response.status}`);
      const data = await response.json();
      const raw = data?.choices?.[0]?.message?.content ?? '{}';
      const parsed = JSON.parse(raw);
      const plan = Array.isArray(parsed.plan)
        ? parsed.plan.filter((s) => s && typeof s.type === 'string')
        : sayPlan(HELP_HINT);
      return {
        intent: String(parsed.intent ?? 'unknown'),
        entities:
          parsed.entities && typeof parsed.entities === 'object'
            ? parsed.entities
            : {},
        plan,
        provider: 'openai',
      };
    },
  };
}

/** Provider factory: rule-based unless a remote provider is explicitly chosen. */
export function createLLMProvider(options = {}) {
  if (options?.name === 'openai' || options?.apiKey) {
    return openAIProvider(options);
  }
  return ruleBasedProvider();
}

/**
 * Parse with the default (rule-based) provider. Synchronous — the default
 * provider never needs the network.
 */
export function parseQuery(text, { provider = null } = {}) {
  const active = provider ?? ruleBasedProvider();
  // Refuse BEFORE invoking parse: an async provider's parse() would fire its
  // network request as a side effect the moment it is called, and a thrown
  // error afterwards cannot un-fire it.
  if (active.async === true || active.kind === 'remote') {
    throw new TypeError(
      'parseQuery received an async provider; use parseQueryAsync instead',
    );
  }
  const result = active.parse(text);
  if (result && typeof result.then === 'function') {
    throw new TypeError(
      'parseQuery received an async provider; use parseQueryAsync instead',
    );
  }
  return { ...result, provider: active.name };
}

/** Parse with any provider, awaiting remote ones. */
export async function parseQueryAsync(text, { provider = null } = {}) {
  const active = provider ?? ruleBasedProvider();
  const result = await active.parse(text);
  return { ...result, provider: active.name };
}

function asGeocodeFn(geocoder) {
  if (!geocoder) return null;
  if (typeof geocoder === 'function') return geocoder;
  if (typeof geocoder.geocode === 'function') {
    return (q) => geocoder.geocode(q);
  }
  return null;
}

/** Normalize the many geocoder result shapes to {lat, lng, label} | null. */
function normalizePlace(result) {
  if (!result || typeof result !== 'object') return null;
  const inner = result.place ?? result;
  if (!inner || typeof inner !== 'object') return null;
  const lat = Number(inner.lat ?? inner.latitude);
  const lng = Number(inner.lng ?? inner.lon ?? inner.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const label =
    String(inner.label ?? inner.name ?? inner.formatted_address ?? '').trim() ||
    `${lat.toFixed(2)}, ${lng.toFixed(2)}`;
  return { lat, lng, label };
}

const FLY_HEIGHTS = Object.freeze({
  country: 12_000_000,
  region: 7_000_000,
  city: 2_500_000,
  place: 1_200_000,
});

function flyHeightFor(place) {
  const types = place?.types ?? [];
  if (types.includes('country') || types.includes('political')) {
    return FLY_HEIGHTS.country;
  }
  if (
    types.includes('administrative_area_level_1') ||
    types.includes('administrative_area_level_2')
  ) {
    return FLY_HEIGHTS.region;
  }
  if (types.includes('locality') || types.includes('sublocality')) {
    return FLY_HEIGHTS.city;
  }
  return FLY_HEIGHTS.place;
}

async function executeStep(step, deps, say) {
  const { layers = {}, camera = null, tour = null, briefing = null } = deps;

  switch (step.type) {
    case 'layer': {
      const handle = layers?.[step.layer];
      const op = step.op === 'hide' ? 'hide' : step.op === 'toggle' ? 'toggle' : 'show';
      if (handle && typeof handle[op] === 'function') {
        await handle[op]();
        return { ok: true };
      }
      say?.(`The '${step.layer}' layer isn't available right now.`);
      return { ok: false, error: `no ${op}() for layer ${step.layer}` };
    }

    case 'fly': {
      const geocode = asGeocodeFn(deps.geocoder);
      let place = null;
      let rawResult = null;
      if (step.place && typeof step.place === 'object') {
        place = normalizePlace(step.place);
      } else if (geocode) {
        try {
          rawResult = await geocode(String(step.place ?? ''));
          place = normalizePlace(rawResult);
        } catch (error) {
          return { ok: false, error: `geocode failed: ${error?.message ?? error}` };
        }
      }
      if (!place) {
        say?.(`I couldn't find '${step.place}' — try a different spelling.`);
        return { ok: false, error: `geocode miss for ${step.place}` };
      }
      if (camera && typeof camera.flyTo === 'function') {
        const inner = rawResult?.place ?? rawResult ?? {};
        await camera.flyTo({
          longitude: place.lng,
          latitude: place.lat,
          heightM: flyHeightFor(inner),
          headingDeg: 0,
          pitchDeg: -60,
          label: place.label,
        });
        return { ok: true, place };
      }
      return { ok: false, error: 'no camera.flyTo' };
    }

    case 'zoom': {
      const dir = step.direction === 'out' ? 'out' : 'in';
      if (camera && typeof camera.zoom === 'function') {
        await camera.zoom(dir);
        return { ok: true };
      }
      if (camera && typeof camera.getPosition === 'function' && typeof camera.flyTo === 'function') {
        const pos = await camera.getPosition();
        const heightM = Number(pos?.heightM ?? pos?.height);
        if (Number.isFinite(heightM) && heightM > 0) {
          await camera.flyTo({
            ...(typeof pos === 'object' ? pos : {}),
            heightM: dir === 'in' ? heightM / 2 : heightM * 2,
          });
          return { ok: true };
        }
      }
      say?.("Zoom isn't available on this camera.");
      return { ok: false, error: 'no zoom affordance' };
    }

    case 'tour': {
      if (!tour) {
        say?.('The tour is not available right now.');
        return { ok: false, error: 'no tour' };
      }
      const started = step.op === 'stop' ? tour.stop?.() : tour.start?.();
      return { ok: started !== false };
    }

    case 'brief': {
      if (typeof briefing === 'function') {
        await briefing();
        return { ok: true };
      }
      if (briefing && typeof briefing.run === 'function') {
        await briefing.run();
        return { ok: true };
      }
      say?.('The briefing is not available right now.');
      return { ok: false, error: 'no briefing' };
    }

    case 'mute': {
      const muted = step.muted !== false;
      if (briefing && typeof briefing.setMuted === 'function') {
        briefing.setMuted(muted);
        return { ok: true };
      }
      say?.(muted ? 'Briefing narration muted.' : 'Briefing narration on.');
      return { ok: true, note: 'no briefing handle; acknowledged only' };
    }

    case 'say': {
      say?.(String(step.text ?? ''));
      return { ok: true };
    }

    default: {
      say?.(HELP_HINT);
      return { ok: false, error: `unknown step type ${step?.type}` };
    }
  }
}

/**
 * Run a parsed plan against injected deps. Returns one result per step and
 * never throws — a failing step is reported, not propagated.
 */
export async function executePlan(plan, deps = {}) {
  const say = typeof deps.say === 'function' ? deps.say : null;
  const steps = Array.isArray(plan) ? plan : [];
  const results = [];
  for (const step of steps) {
    try {
      results.push({ step, ...(await executeStep(step, deps, say)) });
    } catch (error) {
      // Last-resort guard: no step may take the whole plan down.
      try {
        say?.(HELP_HINT);
      } catch {
        /* say itself must not throw either */
      }
      results.push({ step, ok: false, error: String(error?.message ?? error) });
    }
  }
  return results;
}
