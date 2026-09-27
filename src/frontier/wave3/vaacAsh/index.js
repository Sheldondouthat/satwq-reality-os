/**
 * VAAC ash × aviation crosshair — globe layer. Wave 3 (1.8).
 *
 * Renders Washington VAAC IWXXM advisory volumes as 3D extruded polygons
 * (FL band → meters), observation in red, forecasts in amber, and crosses
 * them with military aircraft tracks (altitude-aware). Fail-soft: a dead
 * /api/vaac-polygons leaves an honest empty state. This is the ONLY file in
 * vaacAsh/ that imports Cesium or touches the DOM.
 */
import * as Cesium from 'cesium';
import {
  fetchVaacPolygons,
  flattenAshVolumes,
  crossAshWithAircraft,
  fetchMilAircraft,
} from './model.js';

export * from './model.js';

const POLL_MS = 20 * 60_000;
const FT_TO_M = 0.3048;

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

const kindColor = (kind) =>
  Cesium.Color.fromCssColorString(kind === 'observation' ? '#ff4d4d' : '#ffb020');

export function createVaacAshLayer({ viewer, fetchImpl, pollMs = POLL_MS } = {}) {
  let _enabled = false;
  let _dataSource = null;
  let _timer = null;
  let _status = 'idle';
  let _lastError = null;
  let _snapshot = { advisories: 0, volumes: 0, hits: 0 };
  let _statusHost = null;

  function ensureDataSource() {
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('vaac-ash');
      viewer.dataSources.add(_dataSource);
    }
    return _dataSource;
  }

  async function refresh() {
    _status = 'loading';
    renderStatus();
    try {
      const f = fetchImpl || fetch;
      const body = await fetchVaacPolygons({ fetchImpl: f });
      const volumes = flattenAshVolumes(body.advisories);
      let aircraft = [];
      try {
        aircraft = await fetchMilAircraft({ fetchImpl: f });
      } catch {
        /* mil feed optional */
      }
      const hits = crossAshWithAircraft(volumes, aircraft);
      const hitKeys = new Set(hits.map((h) => `${h.volume.volcano}|${h.volume.time}`));
      const ds = ensureDataSource();
      ds.entities.removeAll();
      for (const vol of volumes) {
        const color = kindColor(vol.kind);
        const flagged = hitKeys.has(`${vol.volcano}|${vol.time}`);
        const upperM = vol.upperFt != null ? vol.upperFt * FT_TO_M : 6100;
        const lowerM = vol.lowerFt != null ? vol.lowerFt * FT_TO_M : 0;
        for (const ring of vol.rings ?? []) {
          ds.entities.add({
            name: `${vol.volcano} ash (${vol.kind})`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
              ),
              height: lowerM,
              extrudedHeight: upperM,
              material: color.withAlpha(flagged ? 0.5 : 0.25),
              outline: true,
              outlineColor: color.withAlpha(0.95),
            },
            description:
              `<b>${vol.volcano}</b> — ${vol.kind}<br>Advisory ${vol.advisoryNumber ?? '?'}<br>` +
              `Valid ${vol.time ?? '?'} · ${vol.lowerFt ?? '?'}–${vol.upperFt ?? '?'} ft<br>` +
              (vol.status ? `Status: ${vol.status}<br>` : '') +
              (flagged ? '<b style="color:#ff4d4d">⚠ aircraft inside ash volume</b>' : ''),
          });
        }
      }
      _snapshot = { advisories: body.count, volumes: volumes.length, hits: hits.length };
      _status = 'live';
      _lastError = null;
    } catch (error) {
      _status = 'unavailable';
      _lastError = error?.message ?? String(error);
    }
    renderStatus();
  }

  function renderStatus() {
    if (!_statusHost) return;
    _statusHost.textContent =
      _status === 'live'
        ? `${_snapshot.advisories} advisories · ${_snapshot.volumes} ash volumes · ${_snapshot.hits} aircraft inside`
        : _status === 'loading'
          ? 'loading ash advisories…'
          : _status === 'unavailable'
            ? `VAAC polygons unavailable (${_lastError ?? 'unknown'})`
            : 'off';
  }

  return {
    init(v) {
      if (v) viewer = v;
    },
    enable(v) {
      if (v) viewer = v;
      if (!viewer || _enabled) return;
      _enabled = true;
      ensureDataSource();
      refresh();
      _timer = setInterval(refresh, pollMs);
    },
    disable() {
      _enabled = false;
      clearInterval(_timer);
      _timer = null;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
    },
    destroy() {
      this.disable();
    },
    getStatus: () => ({ status: _status, summary: _snapshot, lastError: _lastError }),
    isEnabled: () => _enabled,
    attachStatus(host) {
      _statusHost = host;
      renderStatus();
    },
  };
}

/** Dock mounter for initFrontier: section + toggle chip + status line. */
export function mountVaacAshDock({ section, chip, el: elFn, t, layer } = {}) {
  if (!section || !chip || !layer) return null;
  const host = section(t ? t('feature.vaacAsh') : 'VOLCANIC ASH');
  const statusLine = elFn('div', { style: 'font-size:10px;color:#8aa4d6;margin:4px 0;min-height:14px;' }, '—');
  layer.attachStatus(statusLine);
  host.appendChild(
    chip('🌋 Ash volumes', (on) => {
      if (on) layer.enable();
      else layer.disable();
    }, false),
  );
  host.appendChild(statusLine);
  return { element: host, destroy() {} };
}
