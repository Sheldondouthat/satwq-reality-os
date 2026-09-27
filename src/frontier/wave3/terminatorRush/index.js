/**
 * Terminator Rush globe layer — Reality OS Wave 3 (1.4).
 *
 * Pure solar math (NOAA SPA series, client-side, zero keys): a glowing
 * civil-twilight band at solar elevation −6° ± 2° — "sunset happening NOW"
 * — with live events (fires, incidents, NWS alerts, squawks from existing
 * feeds) pinned where they lie on the band.
 *
 * Fail-soft: band renders from math alone; dead event feeds degrade to an
 * honest "events unavailable" note. This is the ONLY file in
 * terminatorRush that imports Cesium.
 */
import * as Cesium from 'cesium';
import {
  terminatorLine,
  subsolarPoint,
  TERMINATOR_CENTER_ELEV,
  TERMINATOR_HALF_WIDTH,
} from './solar.js';
import { fetchBandEvents, eventsOnBand } from './model.js';

const BAND_POLL_MS = 60_000;
const EVENT_POLL_MS = 5 * 60_000;

export * from './solar.js';
export * from './model.js';

function rgba(r, g, b, a = 1) {
  return new Cesium.Color(r, g, b, a);
}

const KIND_COLORS = {
  fire: [1.0, 0.35, 0.1],
  incident: [1.0, 0.8, 0.2],
  alert: [1.0, 0.55, 0.15],
  squawk: [0.4, 0.8, 1.0],
  event: [0.8, 0.85, 1.0],
};

function ringPositions(line) {
  const positions = line.map((p) => Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 2000));
  if (positions.length > 2) positions.push(positions[0].clone()); // close the loop
  return positions;
}

export function createTerminatorRushLayer({ viewer, fetchImpl, bandPollMs = BAND_POLL_MS, eventPollMs = EVENT_POLL_MS } = {}) {
  let _viewer = viewer || null;
  let _enabled = false;
  let _dataSource = null;
  let _bandTimer = null;
  let _eventTimer = null;
  let _status = 'idle';
  let _lastError = null;
  let _summary = { bandPoints: 0, pins: 0, degraded: [] };

  function renderBand(date) {
    const inner = terminatorLine(date, TERMINATOR_CENTER_ELEV - TERMINATOR_HALF_WIDTH);
    const center = terminatorLine(date, TERMINATOR_CENTER_ELEV);
    const outer = terminatorLine(date, TERMINATOR_CENTER_ELEV + TERMINATOR_HALF_WIDTH);

    // Keep the three entities stable across re-renders (lookup by id).
    const upsert = (id, positions, width, color, zIndex) => {
      let entity = _dataSource.entities.getById(id);
      const polyline = {
        positions,
        width,
        material: color,
        clampToGround: false,
        zIndex,
      };
      if (entity) {
        entity.polyline.positions = positions;
      } else {
        _dataSource.entities.add({ id, polyline });
      }
    };

    upsert('term-outer', ringPositions(outer), 3, rgba(1.0, 0.45, 0.1, 0.35), 1);
    upsert('term-center', ringPositions(center), 7, rgba(1.0, 0.72, 0.2, 0.95), 3);
    upsert('term-inner', ringPositions(inner), 3, rgba(0.35, 0.85, 1.0, 0.4), 1);

    // Filled band: inner ring forward + outer ring reversed.
    const fill = [...inner, ...[...outer].reverse()].map((p) =>
      Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 1500),
    );
    let fillEntity = _dataSource.entities.getById('term-fill');
    const hierarchy = new Cesium.PolygonHierarchy(fill);
    if (fillEntity) {
      fillEntity.polygon.hierarchy = hierarchy;
    } else {
      _dataSource.entities.add({
        id: 'term-fill',
        polygon: {
          hierarchy,
          material: rgba(1.0, 0.55, 0.15, 0.12),
          height: 1500,
        },
      });
    }

    _summary.bandPoints = center.length;
  }

  async function refreshEvents(date) {
    try {
      const { events, degradedSources } = await fetchBandEvents({ fetchImpl: fetchImpl || fetch });
      const onBand = eventsOnBand(events, date);
      // Remove old pins, keep band entities.
      for (const entity of [...(_dataSource.entities.values ?? [])]) {
        if (entity.id && !String(entity.id).startsWith('term-')) {
          _dataSource.entities.remove(entity);
        }
      }
      for (const event of onBand) {
        const [r, g, b] = KIND_COLORS[event.kind] ?? KIND_COLORS.event;
        _dataSource.entities.add({
          name: `${event.label} (on the terminator)`,
          description:
            `<b>${String(event.label).replace(/</g, '&lt;')}</b><br>` +
            `Kind: ${event.kind} · Source: ${String(event.source).replace(/</g, '&lt;')}<br>` +
            `Solar elevation here: ${event.solarElevation.toFixed(1)}° ` +
            `(civil-twilight band ${TERMINATOR_CENTER_ELEV}°±${TERMINATOR_HALF_WIDTH}°, computed)`,
          position: Cesium.Cartesian3.fromDegrees(event.lon, event.lat, 4000),
          point: {
            pixelSize: 11,
            color: rgba(r, g, b, 1),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1.5,
          },
        });
      }
      _summary.pins = onBand.length;
      _summary.degraded = degradedSources;
    } catch (error) {
      _lastError = error?.message || 'unknown';
      console.warn('[terminator-rush] events failed:', _lastError);
    }
  }

  function tick() {
    if (!_viewer || !_enabled) return;
    const now = new Date();
    try {
      renderBand(now);
      _status = 'live';
      _lastError = null;
    } catch (error) {
      _status = 'degraded';
      _lastError = error?.message || 'unknown';
    }
  }

  const layer = {
    id: 'terminator-rush',
    name: 'Terminator Rush',
    icon: '🌇',
    source: 'Computed solar geometry (NOAA SPA series) × live feeds',
    updateInterval: bandPollMs,

    init(v) {
      if (_viewer && _viewer !== v) throw new Error('Terminator Rush layer is already initialized');
      _viewer = v || _viewer;
      if (!_viewer) throw new Error('Terminator Rush layer needs a viewer');
      _dataSource = new Cesium.CustomDataSource('terminator-rush');
      _viewer.dataSources.add(_dataSource);
      console.log('[terminator-rush] initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      tick();
      void refreshEvents(new Date());
      if (_bandTimer) clearInterval(_bandTimer);
      if (_eventTimer) clearInterval(_eventTimer);
      _bandTimer = setInterval(tick, bandPollMs);
      _eventTimer = setInterval(() => {
        if (_enabled) void refreshEvents(new Date());
      }, eventPollMs);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      if (_bandTimer) { clearInterval(_bandTimer); _bandTimer = null; }
      if (_eventTimer) { clearInterval(_eventTimer); _eventTimer = null; }
    },

    async update() {
      tick();
      await refreshEvents(new Date());
    },

    flyToSunset() {
      if (!_viewer) return false;
      const sub = subsolarPoint(new Date());
      // Fly to the sunset point opposite the subsolar longitude on the band.
      _viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(sub.lon > 0 ? sub.lon - 90 : sub.lon + 90, sub.lat, 25_000_000),
        duration: 2.5,
      });
      return true;
    },

    getStatus() {
      return { status: _status, summary: _summary, lastError: _lastError, enabled: _enabled };
    },

    destroy() {
      if (_bandTimer) { clearInterval(_bandTimer); _bandTimer = null; }
      if (_eventTimer) { clearInterval(_eventTimer); _eventTimer = null; }
      if (_viewer && _dataSource) _viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
    },
  };

  return layer;
}

/** Dock wiring for initFrontier. */
export function mountTerminatorRushDock({ section, chip, el, t, layer } = {}) {
  if (!section || !chip || !el || !layer) return null;
  const host = section(t ? t('feature.terminatorRush') : 'TERMINATOR RUSH');
  const statusLine = el('div', {
    style: 'font-size:10px;color:#8aa4d6;margin:4px 0;min-height:14px;',
  }, '—');
  const setStatus = () => {
    const s = layer.getStatus();
    const degraded = (s.summary.degraded ?? []).map((d) => d.source).join(',');
    statusLine.textContent =
      s.status === 'live'
        ? `sunset band live · ${s.summary.pins} events on the band` +
          (degraded ? ` · feeds degraded: ${degraded}` : '')
        : s.status === 'loading'
          ? 'loading…'
          : s.status === 'degraded'
            ? `band math ok, issue: ${s.lastError ?? 'unknown'}`
            : 'off';
  };
  host.appendChild(
    chip('🌇 Terminator Rush', (on) => {
      if (on) layer.enable();
      else layer.disable();
      setStatus();
    }, false),
  );
  host.appendChild(
    chip('⌖ Fly to sunset', () => layer.flyToSunset(), false),
  );
  host.appendChild(statusLine);
  const poller = setInterval(setStatus, 60_000);
  return { element: host, destroy() { clearInterval(poller); } };
}
