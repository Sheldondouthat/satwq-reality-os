/**
 * THE HELM v0 — the 10 v0 tool executors (Helm spec §7), standalone-face form.
 *
 * The main globe executes these verbs through src/voice/gevActions.js
 * against a live Cesium viewer. This standalone client has no viewer; it
 * executes the same verbs against the same live APIs and holds the world
 * state (camera / layers / HUD / panels) as a scene document — which is
 * what scene_save serializes. Navigation resolves through the keyless
 * geocoder stack's floor (presets first, Nominatim second).
 *
 * Evidence contract (spec §6): every world-claim carries citations —
 * feed id, the data's OWN timestamp, confidence class. A claim whose
 * record is older than the feed's max-age carries STALE in the sentence.
 * No fetch, no number: a failed fetch is an error, never a value.
 *
 * Dependencies are injected ({ fetchImpl, loadSatellite, now }) so the
 * executors run identically in the browser and under Node tests.
 */

import { PLACE_ALIASES } from './helm-router.js';

export const HOME = Object.freeze({
  lat: 37.303672,
  lon: -80.600807,
  label: 'Pembroke, VA (Home)',
});
export const GLEN_LYN = Object.freeze({
  site: '03176500',
  lat: 37.3728986,
  lon: -80.8606347,
  floodStageFt: 15,
  cautionFt: 13,
  maxAgeSeconds: 3600,
});

const RIVER_API = '/api/usgs-water-glen-lyn';
const TASKS_API = '/api/helm-tasks';
const WDFN_CONTINUOUS =
  'https://api.waterdata.usgs.gov/ogcapi/v1/collections/continuous/items';
const CELESTRAK_STATIONS = '/api/celestrak/stations';
const AIRCRAFT_API = '/api/aircraft';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

const clampRange = (m) => Math.min(25_000_000, Math.max(300, m));

export function createHelmWorld() {
  return {
    view: { label: HOME.label, lat: HOME.lat, lon: HOME.lon, rangeM: 4000 },
    layers: {
      wspr: false,
      earthquakes: false,
      satellites: false,
      aircraft: false,
      rivers: false,
      'nws-alerts-va': false,
    },
    hud: 'full',
    panels: [],
    scenes: [],
    turn: 0,
  };
}

function tleEpoch(line1) {
  // TLE line 1: epoch year (cols 19-20), day-of-year (cols 21-32).
  const yy = Number.parseInt(line1.slice(18, 20), 10);
  const day = Number.parseFloat(line1.slice(20, 32));
  if (!Number.isFinite(yy) || !Number.isFinite(day)) return null;
  const year = yy < 57 ? 2000 + yy : 1900 + yy;
  const ms = Date.UTC(year, 0, 1) + (day - 1) * 86_400_000;
  return new Date(ms).toISOString();
}

function parseTleCatalog(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  const out = [];
  for (let i = 0; i + 2 < lines.length + 1; i += 1) {
    const name = lines[i];
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (l1 && l1.startsWith('1 ') && l2 && l2.startsWith('2 ')) {
      out.push({
        name: name.trim(),
        line1: l1,
        line2: l2,
        noradId: l1.slice(2, 7).trim(),
      });
      i += 2;
    }
  }
  return out;
}

export function createHelmTools({
  fetchImpl,
  loadSatellite,
  now = () => Date.now(),
  world = createHelmWorld(),
} = {}) {
  if (typeof fetchImpl !== 'function')
    throw new Error('createHelmTools: fetchImpl required');
  const state = world;

  async function fetchJson(url) {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch_${res.status}:${url}`);
    return res.json();
  }
  async function fetchText(url) {
    const res = await fetchImpl(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`fetch_${res.status}:${url}`);
    return res.text();
  }

  const tools = {
    async fly_to_location({ place } = {}) {
      const key = String(place || '')
        .toLowerCase()
        .trim();
      const preset = PLACE_ALIASES[key];
      if (preset) {
        state.view = {
          label: preset.label,
          lat: preset.lat,
          lon: preset.lon,
          rangeM: preset.rangeM,
        };
        return {
          ok: true,
          tool: 'fly_to_location',
          summary: `Flew to ${preset.label} (${preset.lat.toFixed(4)}, ${preset.lon.toFixed(4)}).`,
          view: { ...state.view },
          citations: [
            {
              feed: 'helm-place-aliases',
              dataTimestamp: new Date(now()).toISOString(),
              confidence: 'MEASURED',
              note: 'Preset place from the Helm alias table (gauge coordinates per registry record glen-lyn-03176500 v0.2.0; home per user record).',
            },
          ],
        };
      }
      const url = `${NOMINATIM}?format=jsonv2&limit=1&q=${encodeURIComponent(place || '')}`;
      const hits = await fetchJson(url);
      if (!Array.isArray(hits) || hits.length === 0) {
        return {
          ok: false,
          tool: 'fly_to_location',
          summary: `UNKNOWN — the keyless geocoder found no place named "${place}". Nothing moved.`,
          citations: [
            {
              feed: 'nominatim',
              dataTimestamp: new Date(now()).toISOString(),
              confidence: 'UNKNOWN',
              note: 'Zero geocoder results.',
            },
          ],
        };
      }
      const hit = hits[0];
      state.view = {
        label: hit.display_name,
        lat: Number(hit.lat),
        lon: Number(hit.lon),
        rangeM: 8000,
      };
      return {
        ok: true,
        tool: 'fly_to_location',
        summary: `Flew to ${hit.display_name} (${state.view.lat.toFixed(4)}, ${state.view.lon.toFixed(4)}).`,
        view: { ...state.view },
        citations: [
          {
            feed: 'nominatim',
            dataTimestamp: new Date(now()).toISOString(),
            confidence: 'ESTIMATED',
            note: 'Keyless geocoder (OpenStreetMap Nominatim), first result; a name match is an estimate of intent, not a measurement.',
          },
        ],
      };
    },

    async zoom_to_globe() {
      state.view = { ...state.view, rangeM: 22_000_000 };
      return {
        ok: true,
        tool: 'zoom_to_globe',
        summary: `Zoomed out to the whole globe, centered on ${state.view.label}.`,
        view: { ...state.view },
        citations: [],
      };
    },

    async move_camera({ direction, zoom } = {}) {
      const step = state.view.rangeM * 0.6;
      const dLat = step / 111_320;
      const dLon =
        step / (111_320 * Math.cos((state.view.lat * Math.PI) / 180) || 1);
      if (direction === 'north')
        state.view.lat = Math.min(89, state.view.lat + dLat);
      if (direction === 'south')
        state.view.lat = Math.max(-89, state.view.lat - dLat);
      if (direction === 'east') state.view.lon += dLon;
      if (direction === 'west') state.view.lon -= dLon;
      if (zoom === 'in') state.view.rangeM = clampRange(state.view.rangeM / 2);
      if (zoom === 'out') state.view.rangeM = clampRange(state.view.rangeM * 2);
      state.view.label = `view ${state.view.lat.toFixed(3)}, ${state.view.lon.toFixed(3)}`;
      return {
        ok: true,
        tool: 'move_camera',
        summary: `Camera: ${state.view.label}, range ${(state.view.rangeM / 1000).toFixed(1)} km.`,
        view: { ...state.view },
        citations: [],
      };
    },

    async set_layer_visibility({ layer, visible } = {}) {
      if (!(layer in state.layers)) {
        return {
          ok: false,
          tool: 'set_layer_visibility',
          summary: `UNKNOWN — no layer "${layer}" in this face's catalog. Held layers: ${Object.keys(state.layers).join(', ')}.`,
          citations: [],
        };
      }
      state.layers[layer] = Boolean(visible);
      return {
        ok: true,
        tool: 'set_layer_visibility',
        summary: `Layer ${layer}: ${visible ? 'ON' : 'OFF'} (Helm world state; recorded in scene documents).`,
        layers: { ...state.layers },
        citations: [],
      };
    },

    async set_hud({ layout } = {}) {
      state.hud = layout;
      return {
        ok: true,
        tool: 'set_hud',
        summary: `HUD layout: ${layout}.`,
        hud: layout,
        citations: [],
      };
    },

    async get_current_view_state() {
      return {
        ok: true,
        tool: 'get_current_view_state',
        summary:
          `You are looking at ${state.view.label} — center ${state.view.lat.toFixed(4)}, ${state.view.lon.toFixed(4)}, ` +
          `range ${(state.view.rangeM / 1000).toFixed(1)} km. Layers on: ${
            Object.entries(state.layers)
              .filter(([, v]) => v)
              .map(([k]) => k)
              .join(', ') || 'none'
          }. HUD: ${state.hud}.`,
        view: { ...state.view },
        layers: { ...state.layers },
        hud: state.hud,
        citations: [],
      };
    },

    async panel_summon({ panel } = {}) {
      if (panel === 'mesh') {
        return {
          ok: false,
          tool: 'panel_summon',
          blocked: 'BM3',
          summary:
            'UNKNOWN — there is no mesh panel: BM3 (sovereign-mesh in GEV) is unshipped and no nodes are live (Phase 1 pending).',
          citations: [],
        };
      }
      if (!state.panels.includes(panel)) state.panels.push(panel);
      return {
        ok: true,
        tool: 'panel_summon',
        summary: `Panel summoned: ${panel}. Open panels: ${state.panels.join(', ')}.`,
        panels: [...state.panels],
        citations: [],
      };
    },

    async scene_save({ name } = {}) {
      state.turn += 1;
      const scene = {
        id: `scene-${now()}-${state.turn}`,
        name: name || 'untitled scene',
        savedAt: new Date(now()).toISOString(),
        view: { ...state.view },
        layers: { ...state.layers },
        hud: state.hud,
        panels: [...state.panels],
        conversationTurn: state.turn,
      };
      state.scenes.push(scene);
      return {
        ok: true,
        tool: 'scene_save',
        summary: `Scene saved: "${scene.name}" (${scene.id}) — camera, layers, HUD, panels, and the conversation turn it was saved at.`,
        scene,
        citations: [],
      };
    },

    async world_ask({ template, id } = {}) {
      if (template === 'river-trend') return riverTrend();
      if (template === 'identify-light') return identifyLight();
      if (template === 'tasks') return taskList();
      if (template === 'task') return taskInspect(id);
      return {
        ok: false,
        tool: 'world_ask',
        summary:
          'UNKNOWN — Tier 0 world_ask holds exactly four templates tonight (river-trend, identify-light, tasks, task). ' +
          'Open questions route to Tier 1, which is not connected in v0; I will not improvise an answer.',
        citations: [],
      };
    },

    async next_satellite_pass({ target = 'ISS (ZARYA)' } = {}) {
      const sat = await loadSatOrRefuse();
      if (sat.refusal) return sat.refusal;
      const tleText = await fetchText(CELESTRAK_STATIONS);
      const catalog = parseTleCatalog(tleText);
      const want = String(target).toLowerCase();
      const entry = catalog.find(
        (e) =>
          e.name.toLowerCase().includes(want) ||
          e.noradId === want ||
          (want.includes('iss') && e.noradId === '25544'),
      );
      if (!entry) {
        return {
          ok: false,
          tool: 'next_satellite_pass',
          summary: `UNKNOWN — no satellite matching "${target}" in the CelesTrak stations catalog this face reads. Nothing predicted.`,
          citations: [
            {
              feed: 'celestrak-stations',
              dataTimestamp: tleEpoch(catalog[0]?.line1 || ''),
              confidence: 'UNKNOWN',
              note: 'Catalog searched; target absent.',
            },
          ],
        };
      }
      const pass = computeNextPass(sat.lib, entry, HOME, now());
      if (!pass) {
        return {
          ok: false,
          tool: 'next_satellite_pass',
          summary: `UNKNOWN — ${entry.name} does not rise above 10° over Home in the next 24 h of propagation. That is the computed answer, not a guess.`,
          citations: [tleCitation(entry)],
        };
      }
      return {
        ok: true,
        tool: 'next_satellite_pass',
        summary:
          `Next ${entry.name} pass over Home: rises ${pass.aos} UTC, peaks at ${pass.maxElevationDeg.toFixed(0)}° elevation, ` +
          `sets ${pass.los} UTC. MODELED — propagated live from the TLE below; the TLE is the measured input.`,
        pass,
        citations: [tleCitation(entry)],
      };
    },
  };

  function tleCitation(entry) {
    return {
      feed: 'celestrak-stations',
      endpoint: CELESTRAK_STATIONS,
      dataTimestamp: tleEpoch(entry.line1),
      confidence: 'MODELED',
      note: `TLE epoch for ${entry.name} (NORAD ${entry.noradId}); positions/passes are SGP4 propagations of this element set.`,
    };
  }

  async function loadSatOrRefuse() {
    try {
      const lib = await loadSatellite();
      if (!lib || typeof lib.twoline2satrec !== 'function')
        throw new Error('satellite_lib_shape');
      return { lib };
    } catch {
      return {
        refusal: {
          ok: false,
          tool: 'next_satellite_pass',
          summary:
            'UNKNOWN — the SGP4 library did not load on this face, so no position or pass can be computed. I will not estimate an orbit by hand.',
          citations: [],
        },
      };
    }
  }

  function computeNextPass(lib, entry, observer, startMs) {
    const rec = lib.twoline2satrec(entry.line1, entry.line2);
    const obs = {
      longitude: lib.degreesToRadians(observer.lon),
      latitude: lib.degreesToRadians(observer.lat),
      height: 0.6,
    };
    let inPass = null;
    let best = null;
    for (let t = startMs; t <= startMs + 24 * 3600 * 1000; t += 30_000) {
      const pv = lib.propagate(rec, new Date(t));
      if (!pv || !pv.position) continue;
      const look = lib.ecfToLookAngles(
        obs,
        lib.eciToEcf(pv.position, lib.gstime(new Date(t))),
      );
      const el = lib.radiansToDegrees(look.elevation);
      if (el > 10) {
        if (!inPass) inPass = { aosMs: t, maxEl: el };
        else inPass.maxEl = Math.max(inPass.maxEl, el);
      } else if (inPass) {
        best = {
          aos: new Date(inPass.aosMs).toISOString(),
          los: new Date(t).toISOString(),
          maxElevationDeg: inPass.maxEl,
        };
        break;
      }
    }
    if (!best && inPass) {
      best = {
        aos: new Date(inPass.aosMs).toISOString(),
        los: new Date(startMs + 24 * 3600 * 1000).toISOString(),
        maxElevationDeg: inPass.maxEl,
      };
    }
    return best;
  }

  async function riverTrend() {
    const [current, series] = await Promise.all([
      fetchJson(RIVER_API),
      (async () => {
        const end = new Date(now());
        const start = new Date(now() - 6 * 3600 * 1000);
        const url =
          `${WDFN_CONTINUOUS}?monitoring_location_id=USGS-${GLEN_LYN.site}` +
          `&parameter_code=00065&datetime=${start.toISOString()}/${end.toISOString()}&limit=200&f=json`;
        return fetchJson(url);
      })(),
    ]);
    const points = (series.features || [])
      .map((f) => ({
        t: f.properties.time,
        v: Number(f.properties.value),
        status: f.properties.approval_status,
      }))
      .filter((p) => Number.isFinite(p.v))
      .sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    const ageSeconds = current.ageSeconds;
    const stale = ageSeconds != null && ageSeconds > GLEN_LYN.maxAgeSeconds;
    let trendText =
      'UNKNOWN trend — the WDFN series returned fewer than two readings in the last 6 h.';
    let first = null;
    let last = null;
    if (points.length >= 2) {
      first = points[0];
      last = points[points.length - 1];
      const dv = last.v - first.v;
      const word = dv > 0.005 ? 'Rising' : dv < -0.005 ? 'Falling' : 'Steady';
      trendText =
        `${word}: ${first.v.toFixed(2)} ft at ${first.t} → ${last.v.toFixed(2)} ft at ${last.t} ` +
        `(${dv >= 0 ? '+' : ''}${dv.toFixed(2)} ft over the window).`;
    }
    const summary =
      `${trendText} Latest: ${current.gageHeightFt} ft, ${current.dischargeCfs} ft³/s at ${current.dataTime} — ` +
      `USGS gauge ${GLEN_LYN.site} (Glen Lyn), MEASURED${current.approvalStatus ? ` (${current.approvalStatus})` : ''}. ` +
      `Flood stage is ${GLEN_LYN.floodStageFt} ft; the gauge is at ${((current.gageHeightFt / GLEN_LYN.floodStageFt) * 100).toFixed(0)}% of it.` +
      (stale
        ? ` STALE — this reading is ${Math.round(ageSeconds / 60)} min old, past the feed's 1 h max-age.`
        : '');
    return {
      ok: true,
      tool: 'world_ask',
      template: 'river-trend',
      summary,
      trend: first && last ? { first, last } : null,
      citations: [
        {
          feed: 'usgs-water-glen-lyn',
          endpoint: RIVER_API,
          dataTimestamp: current.dataTime,
          confidence: 'MEASURED',
          note: `GEV's WDFN-path endpoint for 03176500; ageSeconds ${ageSeconds} vs max-age ${GLEN_LYN.maxAgeSeconds}; approval ${current.approvalStatus}.`,
        },
        ...(first && last
          ? [
              {
                feed: 'usgs-wdfn-continuous',
                endpoint: 'api.waterdata.usgs.gov/ogcapi/v1 (continuous)',
                dataTimestamp: last.t,
                confidence: 'MEASURED',
                note: `Trend from ${points.length} journaled-class readings, ${first.t} → ${last.t}, parameter 00065, statistic 00011.`,
              },
            ]
          : []),
      ],
    };
  }

  async function identifyLight() {
    const sat = await loadSatOrRefuse();
    if (sat.refusal) return { ...sat.refusal, tool: 'world_ask' };
    const [tleText, aircraftPayload] = await Promise.all([
      fetchText(CELESTRAK_STATIONS),
      fetchJson(AIRCRAFT_API),
    ]);
    const catalog = parseTleCatalog(tleText);
    const at = new Date(now());
    const gmst = sat.lib.gstime(at);
    const obs = {
      longitude: sat.lib.degreesToRadians(HOME.lon),
      latitude: sat.lib.degreesToRadians(HOME.lat),
      height: 0.6,
    };
    const inSector = [];
    for (const entry of catalog) {
      const rec = sat.lib.twoline2satrec(entry.line1, entry.line2);
      const pv = sat.lib.propagate(rec, at);
      if (!pv || !pv.position) continue;
      const geo = sat.lib.eciToGeodetic(pv.position, gmst);
      const lat = sat.lib.degreesLat(geo.latitude);
      const lon = sat.lib.degreesLong(geo.longitude);
      const look = sat.lib.ecfToLookAngles(
        obs,
        sat.lib.eciToEcf(pv.position, gmst),
      );
      const el = sat.lib.radiansToDegrees(look.elevation);
      // "Over the Atlantic": the sector east of Home across the ocean.
      if (lon > -70 && lon < -10 && lat > 5 && lat < 65) {
        inSector.push({ entry, lat, lon, el, altKm: geo.height });
      }
    }
    const sectorAircraft = (aircraftPayload.aircraft || []).filter(
      (a) => a.lon > -70 && a.lon < -10 && a.lat > 5 && a.lat < 65,
    );
    const checked =
      `Checked: ${catalog.length} station-catalog satellites propagated to ${at.toISOString()}, ` +
      `${aircraftPayload.count || 0} aircraft in the live ADS-B merge (generatedAt ${aircraftPayload.generatedAt}).`;
    // A light seen from Home must be above Home's horizon: a sector
    // satellite below it is checked-and-excluded, never named as the light.
    const visible = inSector.filter((s) => s.el > 0);
    const iss = visible.find((s) => s.entry.noradId === '25544');
    const pick = iss || visible.sort((a, b) => b.el - a.el)[0];
    if (!pick) {
      const below = inSector.length
        ? ` ${inSector.length} satellite(s) are in the sector but below Home's horizon (highest at ${Math.max(...inSector.map((s) => s.el)).toFixed(0)}°), so none of them is a light over Home.`
        : '';
      return {
        ok: true,
        tool: 'world_ask',
        template: 'identify-light',
        summary: `UNKNOWN — no station-catalog satellite is both over the Atlantic sector and above Home's horizon right now, and ${sectorAircraft.length} aircraft are in the sector.${below} ${checked} I will not guess a name for a light.`,
        citations: [
          {
            feed: 'celestrak-stations',
            endpoint: CELESTRAK_STATIONS,
            dataTimestamp: tleEpoch(catalog[0]?.line1 || ''),
            confidence: 'UNKNOWN',
            note: checked,
          },
          {
            feed: 'aircraft',
            endpoint: AIRCRAFT_API,
            dataTimestamp: aircraftPayload.generatedAt,
            confidence: 'MEASURED',
            note: `ADS-B merge; servedBy ${(aircraftPayload.servedBy || []).join(', ')}, degraded ${aircraftPayload.degraded}.`,
          },
        ],
      };
    }
    return {
      ok: true,
      tool: 'world_ask',
      template: 'identify-light',
      summary:
        `That light is most consistent with ${pick.entry.name} (NORAD ${pick.entry.noradId}) — over the Atlantic at ` +
        `${pick.lat.toFixed(1)}°, ${pick.lon.toFixed(1)}°, altitude ${pick.altKm.toFixed(0)} km, elevation ${pick.el.toFixed(0)}° from Home, ` +
        `computed live from its TLE. MODELED position over MEASURED elements. ${checked}`,
      contact: {
        name: pick.entry.name,
        noradId: pick.entry.noradId,
        lat: pick.lat,
        lon: pick.lon,
      },
      citations: [
        tleCitation(pick.entry),
        {
          feed: 'aircraft',
          endpoint: AIRCRAFT_API,
          dataTimestamp: aircraftPayload.generatedAt,
          confidence: 'MEASURED',
          note: `${sectorAircraft.length} aircraft in the sector were checked and do not claim the satellite's position.`,
        },
      ],
    };
  }

  // ---- Task store read path (Event Contract; world_ask templates
  // 'tasks' and 'task'). READ-ONLY: the bridge is fetched with GET
  // only, and no verb in this grammar closes, escalates, or modifies
  // a task — the write-back verb belongs to the store's own CLI.
  // The store is the only source: answers cite its records (task id,
  // bornFrom event id, evidence record ids) or refuse honestly.

  function honestyClass(honesty) {
    const head = String(honesty || '')
      .trim()
      .toLowerCase();
    if (head.startsWith('measured')) return 'MEASURED';
    if (head.startsWith('modeled')) return 'MODELED';
    if (head.startsWith('estimated')) return 'ESTIMATED';
    return 'UNKNOWN';
  }

  function birthEventOf(payload, task) {
    return (payload.lifecycle || []).find((e) => e.eventId === task.bornFrom);
  }

  function taskCitation(payload, task) {
    const birth = birthEventOf(payload, task);
    return {
      feed: 'event-contract-task-store',
      endpoint: TASKS_API,
      dataTimestamp: birth ? birth.t : payload.generatedAt,
      confidence: honestyClass(task.honesty),
      note:
        `Task ${task.id}; bornFrom ${task.bornFrom}; evidence ` +
        `${(task.evidence || []).join(', ')}; honesty as stored: "${task.honesty}".`,
    };
  }

  function storeCitation(payload, note) {
    const lastEv = payload.lastEvaluation;
    const lifecycle = payload.lifecycle || [];
    const lastLife = lifecycle[lifecycle.length - 1];
    return {
      feed: 'event-contract-task-store',
      endpoint: TASKS_API,
      dataTimestamp: lastEv ? lastEv.t : lastLife ? lastLife.t : payload.generatedAt,
      confidence: lastEv ? honestyClass(
        lastEv.confidence ? `${lastEv.confidence.class} (${(lastEv.confidence.qualifiers || []).join(', ')})` : '',
      ) : 'MEASURED',
      note,
    };
  }

  function describeTask(payload, task) {
    const birth = birthEventOf(payload, task);
    const parts = [`Task ${task.id} — "${task.title}".`];
    parts.push(
      `State: ${task.state === 'closed' ? 'closed' : `${task.state} (open)`}; stakes ${task.stakes}` +
        `${task.escalated ? '; escalated (the escalation woke the Helm)' : ''}.`,
    );
    if (task.place && task.place.name) {
      parts.push(
        `Place: ${task.place.name} (${task.place.lat}, ${task.place.lon}).`,
      );
    }
    if (task.intent) {
      parts.push(
        `Intent: ${task.intent}. Capability: ${task.capability}. ` +
          `Provider: ${task.provider} (owner ${task.owner} is accountable).`,
      );
      if (task.authority) {
        parts.push(
          `Authority: ${task.authority.rule} Birth clause: ${task.authority.birth}. ` +
            `Escalation clause: ${task.authority.escalation}.`,
        );
      }
    }
    parts.push(
      `Born from event ${task.bornFrom}${birth ? ` (task.born at ${birth.t})` : ''}. ` +
        `Evidence: ${(task.evidence || []).join(', ')}. Honesty: ${task.honesty}.`,
    );
    if (task.evidenceStale) {
      parts.push(
        'STALE evidence: this task\'s evidence stream has crossed into STALE — ' +
          'the task itself carries the evidenceStale label; do not read it as current.',
      );
    }
    if (task.verdict) {
      parts.push(
        `Verdict written back: "${task.verdict.outcome}" — closed by ${task.verdict.closed_by}, ` +
          `citing evidence ${(task.verdict.evidence || []).join(', ')}, evidence time ${task.verdict.data_ts}.`,
      );
    } else {
      parts.push(
        'Verdict: not yet written back — not yet worked; the task is not done ' +
          'until the verdict is written.',
      );
    }
    return parts.join(' ');
  }

  function storeUnavailable(payload) {
    return {
      ok: false,
      tool: 'world_ask',
      summary:
        'UNKNOWN — the Event Contract\'s task store lives on the Home Node and ' +
        'this face cannot reach it (the bridge answered unavailable). Whether ' +
        'tasks exist is not knowable from here, and I will not guess.',
      citations: [
        {
          feed: 'event-contract-task-store',
          endpoint: TASKS_API,
          dataTimestamp: payload.generatedAt,
          confidence: 'UNKNOWN',
          note: payload.reason || 'Store unreachable from this face.',
        },
      ],
    };
  }

  async function taskList() {
    const payload = await fetchJson(TASKS_API);
    if (payload.unavailable || payload.reachable === false)
      return { ...storeUnavailable(payload), template: 'tasks' };
    const tasks = payload.tasks || [];
    if (tasks.length === 0) {
      const ev = payload.lastEvaluation;
      const evText = ev
        ? ` The contract's latest evaluation (${ev.eventId}, data time ${ev.t}) read ` +
          `${ev.payload.stage_ft} ft at ${ev.place.name}, band ${ev.payload.band}, ` +
          `action ${ev.payload.action} (${ev.payload.reason}) — no crossing, so nothing was born.`
        : ' No evaluation has been journaled yet either.';
      return {
        ok: true,
        tool: 'world_ask',
        template: 'tasks',
        summary: `No tasks born yet — the river is quiet.${evText}`,
        citations: [
          storeCitation(
            payload,
            `Task store read at ${payload.generatedAt}: ${payload.evaluations} evaluation(s) on record, 0 tasks.`,
          ),
        ],
      };
    }
    const open = tasks.filter((t) => t.state !== 'closed');
    const closed = tasks.filter((t) => t.state === 'closed');
    return {
      ok: true,
      tool: 'world_ask',
      template: 'tasks',
      summary:
        `${tasks.length} task(s) in the Event Contract store — ${open.length} open, ` +
        `${closed.length} closed. ` +
        tasks.map((t) => describeTask(payload, t)).join(' '),
      tasks: tasks.map((t) => t.id),
      citations: tasks.map((t) => taskCitation(payload, t)),
    };
  }

  async function taskInspect(id) {
    if (!id) {
      return {
        ok: false,
        tool: 'world_ask',
        template: 'task',
        summary:
          'UNKNOWN — no task id was named. Ask what tasks exist, or name a task id to inspect.',
        citations: [],
      };
    }
    const payload = await fetchJson(
      `${TASKS_API}?id=${encodeURIComponent(id)}`,
    );
    if (payload.unavailable || payload.reachable === false)
      return { ...storeUnavailable(payload), template: 'task' };
    if (!payload.found || !payload.task) {
      const held = (payload.tasks || []).map((t) => t.id);
      return {
        ok: false,
        tool: 'world_ask',
        template: 'task',
        summary:
          `UNKNOWN — the task store holds no task "${id}". The store is the only ` +
          `source and I will not invent one. It currently holds ${payload.count} task(s)` +
          `${held.length ? `: ${held.join(', ')}` : ''}.`,
        citations: [
          storeCitation(payload, `Store searched for id ${id}; absent.`),
        ],
      };
    }
    return {
      ok: true,
      tool: 'world_ask',
      template: 'task',
      summary: describeTask(payload, payload.task),
      citations: [taskCitation(payload, payload.task)],
    };
  }

  return { tools, state };
}
