/**
 * THE HELM v0 — Tier 0 DETERMINISTIC router.
 *
 * A parser, not a model (Helm spec §4): exact verbs, the alias table, and
 * place names. A turn that parses cleanly as verbs never spends a model
 * call; a turn that does not parse gets the honest refusal grammar —
 * UNKNOWN, the tools actually held, and the tier statement. Tier 1
 * (local mind, Envy) is NOT connected in v0 and Tier 2 is not built;
 * this router never escalates silently and never invents an answer.
 *
 * Pure module: no DOM, no fetch. Node-testable (src/helm/).
 */

export const HELM_V0_TOOLS = Object.freeze([
  'fly_to_location',
  'zoom_to_globe',
  'move_camera',
  'set_layer_visibility',
  'set_hud',
  'get_current_view_state',
  'world_ask',
  'next_satellite_pass',
  'panel_summon',
  'scene_save',
]);

export const TIER_STATEMENT =
  'TIER 0 — DETERMINISTIC (no model). Tier 1 (local mind, Envy) is not ' +
  'connected in v0 and Tier 2 is not built; v0 does not fake the local mind.';

/** Place aliases resolved without any network call (the keyless floor). */
export const PLACE_ALIASES = Object.freeze({
  home: {
    label: 'Pembroke, VA (Home)',
    lat: 37.303672,
    lon: -80.600807,
    rangeM: 4000,
  },
  pembroke: {
    label: 'Pembroke, VA (Home)',
    lat: 37.303672,
    lon: -80.600807,
    rangeM: 4000,
  },
  'glen lyn': {
    label: 'New River at Glen Lyn, VA — USGS gauge 03176500',
    lat: 37.3728986,
    lon: -80.8606347,
    rangeM: 3000,
  },
  'river gauge': {
    label: 'New River at Glen Lyn, VA — USGS gauge 03176500',
    lat: 37.3728986,
    lon: -80.8606347,
    rangeM: 3000,
  },
  'the gauge': {
    label: 'New River at Glen Lyn, VA — USGS gauge 03176500',
    lat: 37.3728986,
    lon: -80.8606347,
    rangeM: 3000,
  },
  'giles county': {
    label: 'Giles County, VA',
    lat: 37.303672,
    lon: -80.600807,
    rangeM: 30000,
  },
});

/** Layer aliases → Helm world-state layer ids (GEV layer ids where they exist). */
export const LAYER_ALIASES = Object.freeze({
  wspr: 'wspr',
  'radio propagation': 'wspr',
  propagation: 'wspr',
  quakes: 'earthquakes',
  earthquakes: 'earthquakes',
  earthquake: 'earthquakes',
  satellites: 'satellites',
  satellite: 'satellites',
  aircraft: 'aircraft',
  flights: 'aircraft',
  planes: 'aircraft',
  river: 'rivers',
  rivers: 'rivers',
  alerts: 'nws-alerts-va',
  'weather alerts': 'nws-alerts-va',
});

export const PANEL_IDS = Object.freeze([
  'river',
  'view',
  'layers',
  'satellites',
  'scene',
]);

function refusal(kind, summary, missingCapability) {
  return {
    ok: false,
    kind: 'refusal',
    refusalKind: kind,
    ...(missingCapability ? { missingCapability } : {}),
    summary,
    tier: TIER_STATEMENT,
    toolsHeld: [...HELM_V0_TOOLS],
  };
}

/** §1 exchange 3 — receiver_tune is a v2 ACTUATE verb, absent from v0 by design. */
export function blockedReceiverTune() {
  return refusal(
    'blocked-v2-actuate',
    'UNKNOWN — I cannot tune that receiver. receiver_tune is an ACTUATE verb ' +
      'from the Helm v2 build order; the v0 tool set contains no actuation verbs ' +
      'at all (enforcement by absence — the capability is not here to be talked into). ' +
      'Nothing was tuned.',
    'receiver_tune (Helm v2 ACTUATE family; gate: NONE — public receivers, receive-only)',
  );
}

/** §1 exchange 2 — what_changed is not a v0 verb, and its substrate is one feed deep. */
export function blockedWhatChanged() {
  return refusal(
    'blocked-journal',
    'UNKNOWN — I cannot diff the world since yesterday. what_changed is not one of ' +
      'the 10 v0 tools, and its substrate barely exists yet: the Journal Seed ' +
      '(landed 2026-11-15) journals exactly ONE feed — the Glen Lyn gauge — with ' +
      'depth beginning 2026-11-15T07:30:00Z, so "since yesterday" is pre-depth even ' +
      'for the river, and quakes / alerts / RF / mesh have no journal at all. The ' +
      "seed's reader can answer value-at and depth questions on the node itself; " +
      'no endpoint exposes it to this face, and no diff engine exists. I will not ' +
      'fabricate a diff.',
    'what_changed verb (not in v0 set) + journal coverage of quakes/alerts/rf/mesh ' +
      '(Journal Seed covers 1 feed from 2026-11-15T07:30:00Z) + a diff engine + a ' +
      'journal read endpoint for this face',
  );
}

/** §1 exchange 4 — the mesh has no GEV surface until BM3 ships; no nodes are live. */
export function blockedMesh() {
  return refusal(
    'blocked-bm3',
    "UNKNOWN — I cannot open the mesh. There is no mesh to open in God's Eye yet: " +
      'BM3 (the sovereign-mesh registry endpoints + layers in GEV) is specced but ' +
      'unshipped, mesh_status is not one of the 10 v0 tools, and the mesh itself ' +
      'has no live nodes (Phase 1 hardware pending — the Phase 0 placement is ' +
      'MODELED plan data, and it does not live in GEV). Nothing was opened.',
    'BM3 sovereign-mesh endpoints/layers in GEV (register R-29) + mesh_status verb ' +
      '(post-v0) + Phase 1 nodes for a live mesh to exist',
  );
}

function findPlace(text) {
  for (const [alias, place] of Object.entries(PLACE_ALIASES)) {
    if (text.includes(alias)) return { alias, ...place };
  }
  return null;
}

function findLayer(text) {
  // Longest alias first so "weather alerts" beats "alerts"-style prefixes.
  const entries = Object.entries(LAYER_ALIASES).sort(
    (a, b) => b[0].length - a[0].length,
  );
  for (const [alias, id] of entries) {
    if (text.includes(alias)) return id;
  }
  return null;
}

function findPanel(text) {
  if (/\bmesh\b/.test(text)) return 'mesh';
  for (const id of PANEL_IDS) {
    if (text.includes(id)) return id;
  }
  if (text.includes('panel')) return 'view';
  return null;
}

const call = (tool, args = {}) => ({ tool, args });

/**
 * Route one utterance. Returns { ok:true, calls:[{tool,args}...] } or a
 * refusal object. Compound steering (exchange 1) yields multiple calls,
 * executed in order by the page.
 */
export function routeUtterance(rawText) {
  const text = String(rawText || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    return refusal(
      'tier0-no-match',
      'UNKNOWN — empty turn. Say a verb I hold, or a place name.',
    );
  }

  // Blocked exchanges first: these parse cleanly as *requests*, and the
  // honest answer is the named blocker, never a fabricated execution.
  if (/\b(tune|receiver|kiwisdr|websdr|openwebrx)\b/.test(text))
    return blockedReceiverTune();
  if (/what changed|changed since|since yesterday|since last/.test(text))
    return blockedWhatChanged();
  if (/\bmesh\b/.test(text)) return blockedMesh();

  // §1 exchange 5 — identify a light (world_ask template over live records).
  if (
    /that light|light over|what.*\blight\b|bright.*(over|in the sky)/.test(text)
  ) {
    return {
      ok: true,
      calls: [call('world_ask', { template: 'identify-light' })],
    };
  }

  // Task store read path — world_ask templates over /api/helm-tasks
  // (the Event Contract's store; Incorporation Spec Candidate 2,
  // step 3). Read-only: no actuation verb exists for tasks in v0.
  const taskIdMatch =
    text.match(/\b(task-[a-z0-9]+(?:-[a-z0-9]+)*)\b/) ||
    text.match(/\btask\s+(evt-[a-z0-9]+)\b/);
  if (taskIdMatch) {
    const raw = taskIdMatch[1];
    const id = raw.startsWith('task-') ? raw : `task-${raw}`;
    return { ok: true, calls: [call('world_ask', { template: 'task', id })] };
  }
  if (
    /watching the river|who(?:'s| is) watching|what(?:'s| is) watching/.test(
      text,
    ) ||
    /\btasks?\b/.test(text)
  ) {
    return { ok: true, calls: [call('world_ask', { template: 'tasks' })] };
  }

  // §1 exchange 1 — compound: go to the gauge AND answer the river question.
  const place = findPlace(text);
  const riverQuestion =
    /\brising\b|\bfalling\b|river.*\b(up|down|level)\b/.test(text);
  if (
    place &&
    place.alias !== 'home' &&
    place.lat === PLACE_ALIASES['glen lyn'].lat &&
    riverQuestion
  ) {
    return {
      ok: true,
      calls: [
        call('fly_to_location', { place: place.alias }),
        call('panel_summon', { panel: 'river' }),
        call('world_ask', { template: 'river-trend' }),
      ],
    };
  }
  if (/\briver\b|\bgauge\b/.test(text) && riverQuestion) {
    return {
      ok: true,
      calls: [call('world_ask', { template: 'river-trend' })],
    };
  }

  // Satellite passes.
  if (
    /next (iss |satellite )?pass|when.*(iss|satellite).*pass|iss pass/.test(
      text,
    )
  ) {
    const target = /iss|station/.test(text) ? 'ISS (ZARYA)' : 'ISS (ZARYA)';
    return { ok: true, calls: [call('next_satellite_pass', { target })] };
  }

  // Scene save.
  if (/\bsave\b.*\bscene\b|\bscene_save\b/.test(text)) {
    const m = text.match(/save (?:this )?scene(?: as)?\s+(.+)$/);
    return {
      ok: true,
      calls: [call('scene_save', { name: m ? m[1].trim() : 'untitled scene' })],
    };
  }

  // Panels.
  if (
    /\b(open|summon|show|bring up)\b/.test(text) &&
    /(panel|river|layers|satellites|scene|view)/.test(text)
  ) {
    const panel = findPanel(text);
    if (panel) return { ok: true, calls: [call('panel_summon', { panel })] };
  }

  // Layers on/off.
  const layer = findLayer(text);
  if (layer && /\b(on|off|show|hide|turn|enable|disable|layer)\b/.test(text)) {
    const off = /\boff\b|\bhide\b|\bdisable\b/.test(text);
    return {
      ok: true,
      calls: [call('set_layer_visibility', { layer, visible: !off })],
    };
  }

  // HUD.
  if (/\bhud\b/.test(text)) {
    const layout = /\boff\b|hide/.test(text)
      ? 'off'
      : /\bminimal\b/.test(text)
        ? 'minimal'
        : 'full';
    return { ok: true, calls: [call('set_hud', { layout })] };
  }

  // View state.
  if (/where am i|current view|view state|what am i looking at/.test(text)) {
    return { ok: true, calls: [call('get_current_view_state')] };
  }

  // Globe.
  if (/\bglobe\b|whole earth|zoom all the way out/.test(text)) {
    return { ok: true, calls: [call('zoom_to_globe')] };
  }

  // Camera moves.
  const dir = text.match(/\b(north|south|east|west)\b/);
  if (/\b(move|pan|look|go)\b/.test(text) && dir) {
    return { ok: true, calls: [call('move_camera', { direction: dir[1] })] };
  }
  if (/zoom in|closer/.test(text)) {
    return { ok: true, calls: [call('move_camera', { zoom: 'in' })] };
  }
  if (/zoom out/.test(text)) {
    return { ok: true, calls: [call('move_camera', { zoom: 'out' })] };
  }

  // Navigation to a place (alias, or free text for the geocoder).
  const flyMatch = text.match(
    /(?:take me to|fly to|fly me to|go to|navigate to)\s+(.+)$/,
  );
  if (flyMatch) {
    return {
      ok: true,
      calls: [call('fly_to_location', { place: flyMatch[1].trim() })],
    };
  }
  if (place) {
    return {
      ok: true,
      calls: [call('fly_to_location', { place: place.alias })],
    };
  }

  return refusal(
    'tier0-no-match',
    `UNKNOWN — Tier 0 cannot parse that into a verb I hold, and I will not guess. ` +
      `I hold exactly ${HELM_V0_TOOLS.length} tools: ${HELM_V0_TOOLS.join(', ')}. ` +
      `Try "take me to the river gauge and show me if it's rising", "open the river panel", ` +
      `"turn on the wspr layer", or "when is the next ISS pass".`,
  );
}
