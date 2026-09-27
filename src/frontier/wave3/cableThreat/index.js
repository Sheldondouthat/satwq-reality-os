/**
 * Cable-threat globe layer — Reality OS Wave 3 (1.3).
 *
 * Pure in-house spatial join: existing AIS vessel positions (same-origin
 * /api/ais-live, the feed the app's own AIS layer uses) × the bundled
 * TeleGeography submarine-cable polylines. Vessels <0.5 kn for >30 min
 * within 2 km of a cable flash the segment red.
 *
 * Honest states: keyless deploy → /api/ais-live 503 → "AIS feed
 * unavailable". No vessel rows → "0 candidates". Every threat is labeled
 * a CANDIDATE (proximity heuristic, not proof of intent).
 *
 * Client-side only — no new server provider (the cable GeoJSON is a
 * bundled client asset; server-side would need node:fs, banned from the
 * Pages bundle path).
 *
 * This is the ONLY file in cableThreat that imports Cesium.
 */
import * as Cesium from 'cesium';
import { createBundledCableSource } from '../../../layers/submarineCables/bundledSource.js';
import {
  buildCableIndex,
  joinPass,
  SightingTracker,
  CANDIDATE_DIST_M,
  CANDIDATE_SPEED_KN,
} from './model.js';

const DEFAULT_POLL_MS = 5 * 60_000;
const FLASH_MS = 900;

export * from './model.js';

function rgba(r, g, b, a = 1) {
  return new Cesium.Color(r, g, b, a);
}

async function fetchVessels(fetchImpl) {
  const response = await fetchImpl('/api/ais-live?maxRows=50000', { cache: 'no-store' });
  if (!response.ok) {
    const error = new Error(`ais_live_http_${response.status}`);
    error.status = response.status;
    throw error;
  }
  const payload = await response.json();
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

/** Track-based corroboration: span ≥30 min with ≤500 m displacement. */
async function corroborateTrack(mmsi, fetchImpl) {
  try {
    const response = await fetchImpl(`/api/ais-live/track?mmsi=${encodeURIComponent(mmsi)}`, {
      cache: 'no-store',
    });
    if (!response.ok) return false;
    const payload = await response.json();
    const samples = Array.isArray(payload?.samples) ? payload.samples : [];
    if (samples.length < 2) return true; // no track = never moved ≥25 m: consistent
    const first = samples[0];
    const last = samples[samples.length - 1];
    const spanMs = (last.t - first.t) * 1000;
    let maxDisp = 0;
    for (const s of samples) {
      const d = Cesium.Cartesian3.distance(
        Cesium.Cartesian3.fromDegrees(first.lon, first.lat),
        Cesium.Cartesian3.fromDegrees(s.lon, s.lat),
      );
      if (d > maxDisp) maxDisp = d;
    }
    return spanMs >= 30 * 60_000 && maxDisp <= 500;
  } catch {
    return false;
  }
}

function threatDescription(threat) {
  const mins = Math.round(threat.loiterMs / 60_000);
  return (
    `<b>${threat.verdict}</b><br>` +
    `${String(threat.name ?? '').replace(/</g, '&lt;')} (MMSI ${threat.mmsi})` +
    `${threat.type ? ` · ${String(threat.type).replace(/</g, '&lt;')}` : ''}<br>` +
    `Slow &lt;${CANDIDATE_SPEED_KN} kn for ≥${mins} min, ` +
    `moved ≤${Math.round(threat.maxDispM)} m<br>` +
    `Near cable: ${String(threat.nearestCableName ?? '').replace(/</g, '&lt;')} ` +
    `(${Math.round(threat.nearestDistM ?? 0)} m)` +
    `${threat.corroborated ? ' · track-corroborated' : ''}<br>` +
    `<i>${threat.note}</i>`
  );
}

export function createCableThreatLayer({ viewer, fetchImpl, pollMs = DEFAULT_POLL_MS } = {}) {
  let _viewer = viewer || null;
  let _enabled = false;
  let _dataSource = null;
  let _timer = null;
  let _flashTimer = null;
  let _index = null;
  let _tracker = new SightingTracker();
  let _status = 'idle';
  let _lastError = null;
  let _summary = { candidates: 0, threats: 0, cables: 0 };
  const _flashOn = { value: false };

  async function loadCables() {
    const f = fetchImpl || fetch;
    const source = createBundledCableSource({ fetchImpl: f });
    const { cables } = await source.fetch();
    _index = buildCableIndex(cables);
    _summary.cables = _index.cableCount;
  }

  async function refresh() {
    if (!_viewer || !_enabled) return;
    _status = 'loading';
    try {
      if (!_index) await loadCables();
      const f = fetchImpl || fetch;
      const vessels = await fetchVessels(f);
      const { threats } = joinPass(vessels, _index, _tracker);
      // Track corroboration for newly promoted threats (best effort).
      for (const threat of threats) {
        if (!threat.corroborated) {
          const sighting = _tracker.sightings.get(threat.mmsi);
          if (sighting) {
            sighting.corroborated = await corroborateTrack(threat.mmsi, f);
            threat.corroborated = sighting.corroborated;
          }
        }
      }
      render(threats);
      _summary.candidates = _tracker.sightings.size;
      _summary.threats = threats.length;
      _status = 'live';
      _lastError = null;
    } catch (error) {
      _status = 'unavailable';
      _lastError = error?.message || 'unknown';
      console.warn('[cable-threat] refresh failed:', _lastError);
    }
  }

  function render(threats) {
    _dataSource.entities.removeAll();
    for (const threat of threats) {
      const seg = threat.nearestSegRef;
      const positions = seg
        ? [
            Cesium.Cartesian3.fromDegrees(seg.a[0], seg.a[1]),
            Cesium.Cartesian3.fromDegrees(seg.b[0], seg.b[1]),
          ]
        : [
            Cesium.Cartesian3.fromDegrees(threat.lastLon, threat.lastLat),
            Cesium.Cartesian3.fromDegrees(threat.lastLon, threat.lastLat),
          ];
      const entity = _dataSource.entities.add({
        name: `Cable threat — ${threat.name}`,
        description: threatDescription(threat),
        position: positions[0],
        polyline: {
          positions,
          width: 5,
          material: rgba(1, 0.15, 0.1, 0.9),
          clampToGround: true,
        },
        point: {
          pixelSize: 10,
          color: rgba(1, 0.2, 0.1, 1),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1,
        },
      });
      entity._threat = threat;
      entity._flashBase = true;
    }
  }

  function flashTick() {
    _flashOn.value = !_flashOn.value;
    const entities = _dataSource?.entities.values ?? [];
    for (const entity of entities) {
      if (!entity._flashBase || !entity.polyline) continue;
      entity.polyline.material = _flashOn.value
        ? rgba(1, 0.15, 0.1, 1)
        : rgba(0.45, 0.05, 0.05, 0.45);
    }
  }

  const layer = {
    id: 'cable-threat',
    name: 'Cable threats (AIS × cables)',
    icon: '🔌',
    source: 'AIS broadcast metadata × TeleGeography cable routes (in-house join)',
    updateInterval: pollMs,

    init(v) {
      if (_viewer && _viewer !== v) throw new Error('Cable-threat layer is already initialized');
      _viewer = v || _viewer;
      if (!_viewer) throw new Error('Cable-threat layer needs a viewer');
      _dataSource = new Cesium.CustomDataSource('cable-threat');
      _viewer.dataSources.add(_dataSource);
      console.log('[cable-threat] initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      void refresh();
      if (_timer) clearInterval(_timer);
      _timer = setInterval(() => { if (_enabled) void refresh(); }, pollMs);
      if (_flashTimer) clearInterval(_flashTimer);
      _flashTimer = setInterval(flashTick, FLASH_MS);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      if (_timer) { clearInterval(_timer); _timer = null; }
      if (_flashTimer) { clearInterval(_flashTimer); _flashTimer = null; }
    },

    async update() {
      await refresh();
    },

    getStatus() {
      return { status: _status, summary: _summary, lastError: _lastError, enabled: _enabled };
    },

    destroy() {
      if (_timer) { clearInterval(_timer); _timer = null; }
      if (_flashTimer) { clearInterval(_flashTimer); _flashTimer = null; }
      if (_viewer && _dataSource) _viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
    },
  };

  return layer;
}

/** Dock wiring for initFrontier. */
export function mountCableThreatDock({ section, chip, el, t, layer } = {}) {
  if (!section || !chip || !el || !layer) return null;
  const host = section(t ? t('feature.cableThreat') : 'CABLE THREATS');
  const statusLine = el('div', {
    style: 'font-size:10px;color:#8aa4d6;margin:4px 0;min-height:14px;',
  }, '—');
  const noteLine = el('div', {
    style: 'font-size:10px;color:#6b7f9e;margin:2px 0;',
  }, `Slow <${CANDIDATE_SPEED_KN} kn for >30 min within ${CANDIDATE_DIST_M / 1000} km of a cable → flash. Heuristic, not proof.`);
  const setStatus = () => {
    const s = layer.getStatus();
    statusLine.textContent =
      s.status === 'live'
        ? `${s.summary.threats} candidate(s) · ${s.summary.candidates} slow-near sightings · ${s.summary.cables} cables indexed`
        : s.status === 'loading'
          ? 'loading…'
          : s.status === 'unavailable'
            ? `AIS feed unavailable (${s.lastError ?? 'unknown'})`
            : 'off';
  };
  host.appendChild(
    chip('🔌 Cable threats', (on) => {
      if (on) layer.enable();
      else layer.disable();
      setStatus();
    }, false),
  );
  host.appendChild(statusLine);
  host.appendChild(noteLine);
  const poller = setInterval(setStatus, 30_000);
  return { element: host, destroy() { clearInterval(poller); } };
}
