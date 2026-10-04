/**
 * NWS alerts globe layer — Reality OS Wave 3 (1.1).
 *
 * Renders live NWS watches/warnings/advisories with polygon geometry as
 * colored globe polygons (severity-graded), with a click-for-details panel
 * and a trivial cross against fire-perimeter bboxes.
 *
 * Fail-soft: a dead /api/nws-alerts leaves an honest empty state, never a
 * throw. This is the ONLY file in nwsAlerts that imports Cesium, so
 * model.js/panel.js stay testable in plain Node.
 */
import * as Cesium from 'cesium';
import {
  fetchNwsAlerts,
  colorForAlert,
  alertCentroid,
  crossAlertsWithPerimeters,
  filterAlerts,
  sortAlertsBySeverity,
} from './model.js';
import { createAlertDetailsPanel } from './panel.js';

const DEFAULT_POLL_MS = 10 * 60_000;

function toHierarchy(coordinates) {
  // coordinates: ring arrays of [lon,lat] (Polygon) — take outer rings only.
  const positions = [];
  const push = (ring) => {
    for (const pos of ring) {
      if (
        Array.isArray(pos) &&
        Number.isFinite(pos[0]) &&
        Number.isFinite(pos[1])
      ) {
        positions.push(Cesium.Cartesian3.fromDegrees(pos[0], pos[1]));
      }
    }
  };
  return { positions, push };
}

export * from './model.js';
export { createAlertDetailsPanel };

export function createNwsAlertsLayer({
  viewer,
  fetchImpl,
  pollMs = DEFAULT_POLL_MS,
} = {}) {
  let _viewer = viewer || null;
  let _enabled = false;
  let _dataSource = null;
  let _panel = null;
  let _timer = null;
  let _lastError = null;
  let _status = 'idle'; // idle | loading | live | degraded | unavailable
  let _summary = { count: 0, withGeometry: 0, zoneOnly: 0 };
  let _selectHandler = null;

  function rgba({ r, g, b, a }) {
    return new Cesium.Color(r, g, b, a);
  }

  async function fetchPerimeters() {
    try {
      const f = fetchImpl || fetch;
      const response = await f('/api/fire-perimeters', { cache: 'no-store' });
      if (!response.ok) return [];
      const payload = await response.json();
      const features = payload?.features ?? payload?.perimeters ?? [];
      return Array.isArray(features) ? features : [];
    } catch {
      return [];
    }
  }

  async function refresh() {
    if (!_viewer || !_dataSource) return;
    _status = 'loading';
    try {
      const snapshot = await fetchNwsAlerts({ fetchImpl: fetchImpl || fetch });
      const perimeters = await fetchPerimeters();
      const crossed = crossAlertsWithPerimeters(snapshot.alerts, perimeters);
      const withGeom = crossed.filter((c) => c.alert.geometry);
      const ordered = sortAlertsBySeverity(withGeom.map((c) => c.alert));
      const byId = new Map(crossed.map((c) => [c.alert.id, c.fireOverlap]));

      _dataSource.entities.removeAll();
      for (const alert of ordered) {
        const fireOverlap = byId.get(alert.id) ?? false;
        const geometry = alert.geometry;
        const color = colorForAlert(alert);
        const entity = _dataSource.entities.add({
          name: `${alert.event} — ${alert.severity}`,
          polygon: {
            hierarchy: polygonHierarchy(geometry),
            material: rgba(color),
            outline: true,
            outlineColor: rgba({ ...color, a: 0.95 }),
            outlineWidth: 2,
            height: 0,
          },
        });
        entity._nwsAlert = alert;
        entity._nwsFireOverlap = fireOverlap;
      }

      _summary = {
        count: snapshot.count,
        withGeometry: snapshot.withGeometry,
        zoneOnly: snapshot.count - snapshot.withGeometry,
      };
      _status = 'live';
      _lastError = null;
    } catch (error) {
      _status = 'unavailable';
      _lastError = error?.message || 'unknown';
      console.warn('[nws-alerts] refresh failed:', _lastError);
    }
  }

  function polygonHierarchy(geometry) {
    const { positions, push } = toHierarchy(geometry.coordinates);
    if (geometry.type === 'Polygon') {
      for (const ring of geometry.coordinates) push(ring);
    } else {
      for (const poly of geometry.coordinates)
        for (const ring of poly) push(ring);
    }
    return new Cesium.PolygonHierarchy(positions);
  }

  function onSelected(entity) {
    if (!_panel) return;
    const alert = entity?._nwsAlert;
    if (!alert || !_enabled) return;
    _panel.show({ alert, fireOverlap: entity._nwsFireOverlap });
  }

  const layer = {
    id: 'nws-alerts',
    name: 'NWS alerts',
    icon: '⚠',
    source: 'National Weather Service (keyless GeoJSON)',
    updateInterval: pollMs,

    init(v) {
      if (_viewer && _viewer !== v)
        throw new Error('NWS alerts layer is already initialized');
      _viewer = v || _viewer;
      if (!_viewer) throw new Error('NWS alerts layer needs a viewer');
      _dataSource = new Cesium.CustomDataSource('nws-alerts');
      _viewer.dataSources.add(_dataSource);
      _panel = createAlertDetailsPanel({});
      if (_selectHandler)
        _viewer.selectedEntityChanged.removeEventListener(_selectHandler);
      _selectHandler = (entity) => onSelected(entity);
      _viewer.selectedEntityChanged.addEventListener(_selectHandler);
      console.log('[nws-alerts] initialized');
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      void refresh();
      if (_timer) clearInterval(_timer);
      _timer = setInterval(() => {
        if (_enabled) void refresh();
      }, pollMs);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
      _panel?.hide();
    },

    async update() {
      await refresh();
    },

    flyToAlert(alert) {
      const center = alertCentroid(alert);
      if (!center || !_viewer) return false;
      _viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(
          center.lon,
          center.lat,
          600_000,
        ),
        orientation: { heading: 0, pitch: Cesium.Math.toRadians(-60), roll: 0 },
        duration: 2.2,
      });
      return true;
    },

    getStatus() {
      return {
        status: _status,
        summary: _summary,
        lastError: _lastError,
        enabled: _enabled,
      };
    },

    destroy() {
      if (_timer) {
        clearInterval(_timer);
        _timer = null;
      }
      if (_selectHandler && _viewer?.selectedEntityChanged) {
        _viewer.selectedEntityChanged.removeEventListener(_selectHandler);
      }
      if (_dataSource && _viewer) _viewer.dataSources.remove(_dataSource, true);
      _panel?.destroy();
      _panel = null;
      _dataSource = null;
    },
  };

  return layer;
}

/**
 * Dock wiring for initFrontier. Builds the toggle chip + status readout
 * inside the parent's section, using the parent's section/chip/el helpers.
 */
export function mountNwsAlertsDock({ section, chip, el, t, layer } = {}) {
  if (!section || !chip || !el || !layer) return null;
  const host = section(t ? t('feature.nwsAlerts') : 'NWS ALERTS');
  const statusLine = el(
    'div',
    {
      style: 'font-size:10px;color:#8aa4d6;margin:4px 0;min-height:14px;',
    },
    '—',
  );
  const setStatus = () => {
    const s = layer.getStatus();
    statusLine.textContent =
      s.status === 'live'
        ? `${s.summary.count} active alerts · ${s.summary.withGeometry} with polygons · ${s.summary.zoneOnly} zone-referenced`
        : s.status === 'loading'
          ? 'loading…'
          : s.status === 'unavailable'
            ? `NWS feed unavailable (${s.lastError ?? 'unknown'})`
            : 'off';
  };
  host.appendChild(
    chip(
      '⚠ NWS alerts',
      (on) => {
        if (on) layer.enable();
        else layer.disable();
        setStatus();
      },
      false,
    ),
  );
  host.appendChild(statusLine);
  const poller = setInterval(setStatus, 30_000);
  return {
    element: host,
    destroy() {
      clearInterval(poller);
    },
  };
}
