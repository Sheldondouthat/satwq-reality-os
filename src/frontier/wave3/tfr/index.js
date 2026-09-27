/**
 * TFR lockdown overlay — globe layer. Wave 3 (1.5).
 *
 * Renders FAA Temporary Flight Restrictions as red polygons, flags military
 * aircraft (keyless adsb.lol mil proxy) inside active TFRs, and crosses TFRs
 * with fire-perimeter bboxes. Fail-soft: a dead /api/tfrs leaves an honest
 * empty state, never a throw. This is the ONLY file in tfr/ that imports
 * Cesium or touches the DOM.
 */
import * as Cesium from 'cesium';
import {
  fetchTfrs,
  fetchMilAircraft,
  flagFlightsInsideTfrs,
  crossTfrsWithFires,
  tfrCentroid,
  tfrColorFor,
} from './model.js';

export * from './model.js';

const POLL_MS = 15 * 60_000;

function el(tag, attrs = {}, text = '') {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'style') node.style.cssText = v;
    else node.setAttribute(k, v);
  }
  if (text) node.textContent = text;
  return node;
}

export function createTfrLayer({ viewer, fetchImpl, pollMs = POLL_MS } = {}) {
  let _enabled = false;
  let _dataSource = null;
  let _panel = null;
  let _timer = null;
  let _status = 'idle';
  let _lastError = null;
  let _snapshot = { count: 0, withGeometry: 0, hits: 0, fireCross: 0 };

  function ensureDataSource() {
    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('tfr-lockdown');
      viewer.dataSources.add(_dataSource);
    }
    return _dataSource;
  }

  async function refresh() {
    _status = 'loading';
    try {
      const f = fetchImpl || fetch;
      const body = await fetchTfrs({ fetchImpl: f });
      let aircraft = [];
      try {
        aircraft = await fetchMilAircraft({ fetchImpl: f });
      } catch {
        /* mil feed optional */
      }
      let perimeters = [];
      try {
        const r = await f('/api/fire-perimeters', { cache: 'no-store' });
        if (r.ok) {
          const pb = await r.json();
          perimeters = (pb?.perimeters ?? pb?.features ?? []).map((p) => ({
            bbox: p.bbox ?? p?.properties?.bbox ?? null,
          }));
        }
      } catch {
        /* fire feed optional */
      }
      const ds = ensureDataSource();
      ds.entities.removeAll();
      const hits = flagFlightsInsideTfrs(body.tfrs, aircraft);
      const fireCross = crossTfrsWithFires(body.tfrs, perimeters);
      const hitTfrIds = new Set(hits.map((h) => h.tfr.id));
      const fireTfrIds = new Set(fireCross.map((h) => h.tfr.id));
      for (const tfr of body.tfrs) {
        const color = Cesium.Color.fromCssColorString(tfrColorFor(tfr.type));
        const flagged = hitTfrIds.has(tfr.id);
        for (const ring of tfr.rings ?? []) {
          ds.entities.add({
            name: `TFR ${tfr.id}`,
            polygon: {
              hierarchy: new Cesium.PolygonHierarchy(
                ring.map(([lon, lat]) => Cesium.Cartesian3.fromDegrees(lon, lat)),
              ),
              material: color.withAlpha(flagged ? 0.45 : 0.22),
              outline: true,
              outlineColor: color.withAlpha(0.9),
              height: 0,
            },
            description:
              `<b>TFR ${tfr.id}</b> (${tfr.type})<br>${tfr.description ?? ''}<br>` +
              `Effective ${tfr.effective ?? '?'} → ${tfr.expires ?? '?'}<br>` +
              (flagged ? '<b style="color:#ff4d6d">⚠ aircraft inside</b><br>' : '') +
              (fireTfrIds.has(tfr.id) ? '🔥 overlaps a fire perimeter<br>' : '') +
              `Alt: ${(tfr.areas?.[0]?.lowerFt ?? '?')}–${(tfr.areas?.[0]?.upperFt ?? '?')} ft`,
          });
        }
        const centroid = tfrCentroid(tfr);
        if (centroid) {
          ds.entities.add({
            name: `TFR ${tfr.id} marker`,
            position: Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat),
            billboard: {
              image: 'data:image/svg+xml,' + encodeURIComponent(
                `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><circle cx="10" cy="10" r="8" fill="none" stroke="${flagged ? '#ff4d6d' : '#ff9f1c'}" stroke-width="3"/></svg>`,
              ),
              width: 18,
              height: 18,
            },
          });
        }
      }
      _snapshot = {
        count: body.count,
        withGeometry: body.withGeometry,
        hits: hits.length,
        fireCross: fireCross.length,
      };
      _status = 'live';
      _lastError = null;
      renderPanel();
    } catch (error) {
      _status = 'unavailable';
      _lastError = error?.message ?? String(error);
      renderPanel();
    }
  }

  function renderPanel() {
    if (!_panel) return;
    _panel.innerHTML = '';
    const line = el('div', { style: 'font-size:11px;color:#8aa4d6;' });
    if (_status === 'live') {
      line.textContent =
        `${_snapshot.count} active TFRs · ${_snapshot.withGeometry} with polygons · ` +
        `${_snapshot.hits} aircraft inside · ${_snapshot.fireCross} fire overlaps`;
    } else if (_status === 'loading') {
      line.textContent = 'loading TFRs…';
    } else {
      line.textContent = `TFR feed unavailable (${_lastError ?? 'unknown'})`;
    }
    _panel.appendChild(line);
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
      _panel?.remove();
      _panel = null;
    },
    getStatus: () => ({ status: _status, summary: _snapshot, lastError: _lastError }),
    isEnabled: () => _enabled,
    attachPanel(host) {
      _panel = host;
      renderPanel();
    },
  };
}

/** Dock mounter for initFrontier: section + toggle chip + status line. */
export function mountTfrDock({ section, chip, el: elFn, t, layer } = {}) {
  if (!section || !chip || !layer) return null;
  const host = section(t ? t('feature.tfrLockdown') : 'TFR LOCKDOWN');
  const statusLine = elFn('div', { style: 'font-size:10px;color:#8aa4d6;margin:4px 0;min-height:14px;' }, '—');
  layer.attachPanel(statusLine);
  const setStatus = () => {
    const s = layer.getStatus();
    statusLine.textContent =
      s.status === 'live'
        ? `${s.summary.count} active · ${s.summary.withGeometry} polygons · ${s.summary.hits} aircraft inside`
        : s.status === 'loading' ? 'loading…' : s.status === 'unavailable'
          ? `TFR feed unavailable (${s.lastError ?? 'unknown'})` : 'off';
  };
  host.appendChild(
    chip('🚫 TFRs', (on) => {
      if (on) layer.enable();
      else layer.disable();
      setStatus();
    }, false),
  );
  host.appendChild(statusLine);
  const poller = setInterval(setStatus, 30_000);
  return { element: host, destroy() { clearInterval(poller); } };
}
